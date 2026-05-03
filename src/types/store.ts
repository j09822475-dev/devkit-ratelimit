/**
 * Storage contract — every adapter implements this interface. The contract
 * is intentionally algorithm-aware: the store dispatches on `spec.kind` to
 * pick the right atomic primitive (Redis EVAL script, KV CAS loop, in-memory
 * critical section, D1 single-statement CTE).
 */

import type { AlgorithmSpec } from './algorithm.js';
import type { RateLimitState } from './result.js';

/**
 * Result of a single `consume()` call — the state numbers plus the binary
 * decision. The store is the single source of truth for the decision; the
 * manager neither pre-checks nor post-corrects this value.
 */
export interface ConsumeResult extends RateLimitState {
  readonly allowed: boolean;
}

/**
 * Storage adapter contract. Every method is async even when the underlying
 * implementation is synchronous (the memory store) so adapters can be
 * swapped without touching call sites.
 */
export interface RateLimitStore {
  /**
   * Atomically apply the algorithm and return the resulting state.
   *
   * @param key  Fully-qualified storage key (`{prefix}:{scope}:{userKey}`).
   * @param spec Algorithm spec (sliding window / token bucket / etc.).
   * @param cost Permits requested. MUST be `≥ 0`. Cost `0` is a peek-like
   *             "evaluate the current bucket without consuming".
   * @param now  Wall-clock milliseconds, supplied by the manager.
   * @returns    The post-consume state plus an `allowed` decision.
   */
  consume(
    key: string,
    spec: AlgorithmSpec,
    cost: number,
    now: number,
  ): Promise<ConsumeResult>;

  /**
   * Read the current state for a key without consuming. Returns the same
   * shape as `consume(..., cost: 0)` but without the `allowed` field —
   * peek is a query, not a decision.
   *
   * @param key  Fully-qualified storage key.
   * @param spec Algorithm spec.
   * @param now  Wall-clock milliseconds.
   * @returns    The current state for the key.
   */
  peek(key: string, spec: AlgorithmSpec, now: number): Promise<RateLimitState>;

  /**
   * Reset the counter for a key. Returns `true` iff state existed.
   *
   * @param key Fully-qualified storage key.
   * @returns   `true` if there was something to reset, `false` otherwise.
   */
  reset(key: string): Promise<boolean>;

  /**
   * Optional bulk garbage collection of expired records. Stores with
   * native TTL implement this as a no-op; stores without (memory, D1)
   * implement a sweep call back-stopped by `sweepIntervalMs`.
   *
   * @param now Optional override for the current wall-clock time.
   * @returns   The number of records swept.
   */
  sweep?(now?: number): Promise<number>;

  /**
   * Optional human-readable label for observability events and error
   * messages (`'memory'`, `'redis'`, `'kv'`, `'d1'`, `'do'`, `'upstash'`).
   */
  readonly name?: string;
}
