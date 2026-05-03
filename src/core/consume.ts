/**
 * Single "atomic consume" pipeline. Wraps `store.consume` / `store.peek`
 * with the manager-level concerns: error wrapping, fail-open degradation,
 * cost validation, payload-too-large guards.
 */

import { RateLimitError } from '../errors/base.js';
import type { AlgorithmSpec } from '../types/algorithm.js';
import type { RateLimitState } from '../types/result.js';
import type { ConsumeResult, RateLimitStore } from '../types/store.js';

/**
 * Result returned by {@link runConsume}, carrying both the post-consume
 * state and a `degraded` flag that signals fail-open swallowed an error.
 */
export interface ConsumePipelineResult extends ConsumeResult {
  readonly degraded: boolean;
}

/**
 * Validate a `cost` value passed to `check()`. `cost === 0` is permitted
 * (peek-like); negative or non-finite values throw `INVALID_COST`.
 *
 * @param cost Cost value to validate.
 * @throws     `RateLimitError('INVALID_COST')` on bad input.
 */
export function assertValidCost(cost: number): void {
  if (typeof cost !== 'number' || !Number.isFinite(cost) || cost < 0) {
    throw new RateLimitError(
      'INVALID_COST',
      `cost must be a non-negative finite number, got ${String(cost)}`,
    );
  }
}

/**
 * Compute the algorithm's "capacity" for a `cost > capacity` short-circuit
 * check. Returns `undefined` for algorithms that don't have a fixed
 * capacity (sliding-window-log handles this dynamically).
 *
 * @param spec Algorithm spec.
 * @returns    The fixed capacity, or `undefined`.
 */
export function specCapacity(spec: AlgorithmSpec): number | undefined {
  switch (spec.kind) {
    case 'token-bucket':
    case 'leaky-bucket':
      return spec.capacity;
    case 'sliding-window-counter':
    case 'sliding-window-log':
    case 'fixed-window':
      return spec.limit;
    default: {
      const exhaustive: never = spec;
      void exhaustive;
      return undefined;
    }
  }
}

/**
 * Compute the window length (ms) advertised by an algorithm. Used to
 * produce a synthetic `retryAfter` for the `cost > capacity` branch.
 *
 * @param spec Algorithm spec.
 * @returns    Window length in milliseconds.
 */
export function specWindowMs(spec: AlgorithmSpec): number {
  switch (spec.kind) {
    case 'token-bucket':
    case 'leaky-bucket':
      return spec.intervalMs;
    case 'sliding-window-counter':
    case 'sliding-window-log':
    case 'fixed-window':
      return spec.windowMs;
    default: {
      const exhaustive: never = spec;
      void exhaustive;
      return 0;
    }
  }
}

/**
 * Run the store's `consume` and translate any thrown error into either a
 * `STORE_UNAVAILABLE` `RateLimitError` (fail-closed) or a degraded
 * synthetic state (fail-open).
 *
 * @param store    Storage adapter.
 * @param key      Fully-qualified store key.
 * @param spec     Algorithm spec.
 * @param cost     Permits requested.
 * @param now      Wall-clock milliseconds.
 * @param failOpen Fail-open flag.
 * @returns        Consume pipeline result.
 * @throws         `RateLimitError('STORE_UNAVAILABLE')` when fail-closed
 *                 and the store throws.
 */
export async function runConsume(
  store: RateLimitStore,
  key: string,
  spec: AlgorithmSpec,
  cost: number,
  now: number,
  failOpen: boolean,
): Promise<ConsumePipelineResult> {
  // `cost > capacity` short-circuit: do not even hit the store. The cost
  // can be a runtime value (LLM token estimate) so we resolve as
  // `allowed: false` rather than throwing.
  const capacity = specCapacity(spec);
  if (capacity !== undefined && cost > capacity) {
    const window = specWindowMs(spec);
    return {
      allowed: false,
      limit: capacity,
      remaining: 0,
      reset: now + window,
      retryAfter: window,
      degraded: false,
    };
  }
  try {
    const result = await store.consume(key, spec, cost, now);
    return { ...result, degraded: false };
  } catch (err) {
    return failOrDegrade(err, store, spec, now, failOpen);
  }
}

/**
 * Run the store's `peek` and translate any thrown error symmetrically with
 * {@link runConsume}.
 *
 * @param store    Storage adapter.
 * @param key      Fully-qualified store key.
 * @param spec     Algorithm spec.
 * @param now      Wall-clock milliseconds.
 * @param failOpen Fail-open flag.
 * @returns        Peek result with `degraded` and `allowed: true`.
 * @throws         `RateLimitError('STORE_UNAVAILABLE')` when fail-closed
 *                 and the store throws.
 */
export async function runPeek(
  store: RateLimitStore,
  key: string,
  spec: AlgorithmSpec,
  now: number,
  failOpen: boolean,
): Promise<ConsumePipelineResult> {
  try {
    const state = await store.peek(key, spec, now);
    return { ...state, allowed: true, degraded: false };
  } catch (err) {
    return failOrDegrade(err, store, spec, now, failOpen);
  }
}

/**
 * Wrap a store error and either re-throw (fail-closed) or return a
 * synthetic degraded state (fail-open).
 */
function failOrDegrade(
  err: unknown,
  store: RateLimitStore,
  spec: AlgorithmSpec,
  now: number,
  failOpen: boolean,
): ConsumePipelineResult {
  const wrapped = wrapStoreError(err, store);
  if (!failOpen) throw wrapped;
  const capacity = specCapacity(spec) ?? 0;
  return {
    allowed: true,
    limit: capacity,
    remaining: capacity,
    reset: now,
    retryAfter: 0,
    degraded: true,
  };
}

/**
 * Wrap an unknown thrown value in a `STORE_UNAVAILABLE` `RateLimitError`,
 * preserving the original cause for debugging while keeping the public
 * message free of secrets.
 *
 * @param err   The thrown value.
 * @param store The store that produced it (for the name prefix).
 * @returns     A `RateLimitError` with code `STORE_UNAVAILABLE`.
 */
export function wrapStoreError(err: unknown, store: RateLimitStore): RateLimitError {
  if (RateLimitError.is(err)) return err;
  const name = store.name ?? 'store';
  const detail =
    err instanceof Error
      ? err.name
      : typeof err === 'string'
        ? 'string-thrown'
        : 'unknown';
  return new RateLimitError('STORE_UNAVAILABLE', `${name}: ${detail}`, err);
}

/**
 * Identity helper used by the limiter to project a `ConsumePipelineResult`
 * onto a {@link RateLimitState}. Keeps the call site terse without an
 * inline destructuring repetition.
 *
 * @param r Pipeline result.
 * @returns The state portion of the result.
 */
export function asState(r: ConsumePipelineResult): RateLimitState {
  return {
    limit: r.limit,
    remaining: r.remaining,
    reset: r.reset,
    retryAfter: r.retryAfter,
  };
}
