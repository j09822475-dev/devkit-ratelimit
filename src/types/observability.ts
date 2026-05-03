/**
 * Observability hook types — the manager emits one of these structured
 * events for every check / peek so consumers can wire metrics, logs and
 * alerts with one switch.
 */

import type { AlgorithmSpec } from './algorithm.js';
import type { RateLimitState } from './result.js';
import type { RateLimitError } from '../errors/base.js';

/**
 * Discriminated event object passed to {@link RateLimitHook}.
 *
 * @typeParam K Caller-defined context returned by the structured key
 *              generator (`undefined` when not used).
 */
export interface RateLimitObservation<K = undefined> {
  readonly type:
    | 'rate-limit.allowed'
    | 'rate-limit.blocked'
    | 'rate-limit.skipped'
    | 'rate-limit.error';
  readonly key: string;
  readonly state: RateLimitState;
  readonly algorithm: AlgorithmSpec;
  readonly cost: number;
  /** Wall-clock milliseconds when the operation started. */
  readonly startedAt: number;
  /** Milliseconds spent inside the limiter pipeline. */
  readonly elapsedMs: number;
  /** HTTP method extracted from the request. */
  readonly method: string;
  /** Pathname of the request URL (no query string). */
  readonly path: string;
  /** The raw `Request`. Most consumers should read `method`/`path` instead. */
  readonly request: Request;
  /** Caller context returned by the structured key generator. */
  readonly context: K;
  /** Present iff `type === 'rate-limit.error'`. */
  readonly error?: RateLimitError;
  /**
   * Optional discriminator a composition emits — `'tiered:free'`,
   * `'compose-all[1]'`, etc. Set by composition limiters; never by core.
   */
  readonly source?: string;
}

/**
 * Observability hook — receives a single structured event for every
 * check / peek / skip / error path.
 *
 * @typeParam K Caller-defined context payload type.
 */
export type RateLimitHook<K = undefined> = (
  event: RateLimitObservation<K>,
) => void | Promise<void>;
