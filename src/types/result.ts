/**
 * Public result + state types returned from the limiter. These are the
 * data shapes consumers read on every `check()` / `peek()` call.
 */

/**
 * Live, header-style-independent view of the rate-limit state. Consumers
 * building dashboards or custom transports read from here; the same
 * numbers serialise into `RateLimitResult.headers`.
 */
export interface RateLimitState {
  /** Configured maximum permitted within the window / bucket. */
  readonly limit: number;
  /** Permits remaining at the moment of the check (clamped to ≥0). */
  readonly remaining: number;
  /**
   * Unix milliseconds at which the next permit becomes available, or the
   * fixed window resets — whichever is sooner.
   */
  readonly reset: number;
  /**
   * Milliseconds to wait before the next permit is available. `0` when
   * `allowed === true`.
   */
  readonly retryAfter: number;
}

/**
 * The outcome of a single `limiter.check(req)` call. `headers` is a fresh
 * `Headers` object pre-filled per the configured `headerStyle` so the
 * caller can either pass it on the 429 response or merge it into the
 * success response so clients see the live policy.
 *
 * @typeParam K Caller-defined context returned from the structured key
 *              generator. `undefined` when not used.
 */
export interface RateLimitResult<K = undefined> {
  /** `true` when the request is permitted; `false` when over the limit. */
  readonly allowed: boolean;
  /** The opaque key the request was bucketed against. Useful for logs. */
  readonly key: string;
  /** Live state — the same numbers serialised into `headers`. */
  readonly state: RateLimitState;
  /** Pre-filled response headers per the configured `headerStyle`. */
  readonly headers: Headers;
  /**
   * `true` when the result was produced under fail-open degradation —
   * either the store was unavailable (and `failOpen: true` swallowed the
   * error) or `peek()` returned a stale last-known state.
   */
  readonly degraded: boolean;
  /**
   * Caller-defined context returned by the `keyGenerator` when the
   * structured `{ key, context }` form is used. Typed as `K`; `undefined`
   * when the key generator returned a bare string.
   */
  readonly context: K;
}
