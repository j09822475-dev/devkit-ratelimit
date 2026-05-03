/**
 * Public limiter handle + middleware types.
 */

import type { NormalisedRateLimitConfig } from './config.js';
import type { RateLimitResult } from './result.js';

/**
 * Web-Standard middleware shape — `Response` when blocked, `undefined`
 * when allowed.
 */
export type RateLimiterMiddleware = (req: Request) => Promise<Response | undefined>;

/**
 * The frozen handle returned by `createRateLimiter`. Safe to share across
 * requests in the same runtime instance.
 *
 * @typeParam K Caller-defined context payload threaded from the structured
 *              key generator.
 */
export interface RateLimiter<K = undefined> {
  /**
   * Atomically consume one (or `cost`) permit(s) for the request's key.
   *
   * Throws `RateLimitError('STORE_UNAVAILABLE')` when the underlying store
   * is unreachable and `failOpen` is `false` (the default); under
   * `failOpen: true`, returns `{ allowed: true, degraded: true }`.
   *
   * @param req  Web-Standard `Request`.
   * @param opts Optional per-call cost override.
   * @returns    The rate-limit result.
   * @throws     `RateLimitError` on store unavailability or invalid cost.
   * @example
   *   const result = await limiter.check(req);
   *   if (!result.allowed) {
   *     return new Response('rate limited', { status: 429, headers: result.headers });
   *   }
   */
  check(req: Request, opts?: { cost?: number }): Promise<RateLimitResult<K>>;

  /**
   * Inspect the current state for a request without consuming a permit.
   * Honours `failOpen` symmetrically with `check()`.
   *
   * @param req Web-Standard `Request`.
   * @returns   The current rate-limit state with `allowed: true`.
   * @throws    `RateLimitError` when the store is unavailable and
   *            `failOpen: false`.
   */
  peek(req: Request): Promise<RateLimitResult<K>>;

  /**
   * Reset the counter for the request's key.
   *
   * @param req Web-Standard `Request`.
   * @returns   `true` iff state existed for the key.
   */
  reset(req: Request): Promise<boolean>;

  /**
   * Reset by an explicit key — for jobs that don't have a `Request`.
   *
   * @param key The bucketing key (plain user key, not the qualified
   *            store key — the limiter prepends `prefix:scope`).
   * @returns   `true` iff state existed for the key.
   */
  resetKey(key: string): Promise<boolean>;

  /**
   * Return a Web-Standard middleware that resolves to a `Response` (429)
   * when blocked and `undefined` when allowed.
   *
   * @returns A function from `Request` to `Promise<Response | undefined>`.
   * @example
   *   const middleware = limiter.middleware();
   *   const blocked = await middleware(req);
   *   if (blocked) return blocked;
   */
  middleware(): RateLimiterMiddleware;

  /**
   * Return a per-request clone of the limiter with `executionCtx` bound,
   * so observability hooks fired during `check()` / `peek()` can use
   * `executionCtx.waitUntil(...)` under `hookMode === 'wait-until'`.
   *
   * Framework adapters call this once per inbound request when they
   * have access to a Cloudflare/Vercel `executionCtx` — the returned
   * handle shares the underlying store and configuration but carries
   * the request-scoped `executionCtx`. Cheap (no normalisation; just a
   * shallow `Object.freeze` over the cloned config).
   *
   * @param executionCtx The runtime-provided execution context.
   * @returns            A frozen, request-scoped {@link RateLimiter}.
   * @example
   *   // inside a Hono middleware
   *   const scoped = limiter.withExecutionCtx(c.executionCtx);
   *   const result = await scoped.check(c.req.raw);
   */
  withExecutionCtx(executionCtx: { waitUntil(p: Promise<unknown>): void }): RateLimiter<K>;

  /**
   * The frozen, normalised configuration the limiter was constructed
   * with — exposed for observability and framework-adapter introspection.
   */
  readonly config: Readonly<NormalisedRateLimitConfig<K>>;
}
