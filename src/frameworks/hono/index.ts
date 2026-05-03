/**
 * Hono adapter — Web-Standard `Request` makes this trivial. The middleware
 * runs the limiter, exposes the result on `c.var.rateLimit`, and either
 * short-circuits with a 429 or merges the limiter's headers into the
 * downstream response.
 *
 * When the limiter is built with `hookMode: 'wait-until'` and `c.executionCtx`
 * is available (Workers / Vercel Edge), the adapter rebinds the limiter
 * via `limiter.withExecutionCtx(c.executionCtx)` so the observability hook
 * runs through `executionCtx.waitUntil` and never adds to TTFB.
 */

import type { RateLimiter } from '../../types/limiter.js';
import type { RateLimitResult } from '../../types/result.js';

/**
 * Loose Hono context shape — kept narrow so we don't need to import the
 * `hono` package as a runtime dependency. Compatible with Hono v4.
 */
interface HonoContextLike<K> {
  req: { raw: Request };
  res?: Response;
  set(key: string, value: unknown): void;
  get(key: 'rateLimit'): RateLimitResult<K> | undefined;
  executionCtx?: { waitUntil(p: Promise<unknown>): void };
}

type HonoNext = () => Promise<void>;

/**
 * Build a Hono middleware that runs the limiter on every request. On block,
 * either calls `opts.onLimit(c)` or returns a default 429.
 *
 * @typeParam K Caller-defined context payload type threaded from the
 *              limiter's structured key generator.
 * @param limiter The {@link RateLimiter} handle.
 * @param opts    Optional override for the 429 response builder.
 * @returns       A Hono-compatible middleware function.
 * @example
 *   import { honoRateLimit } from '@devkit/ratelimit/frameworks/hono';
 *   app.use('*', honoRateLimit(limiter));
 */
export function honoRateLimit<K = undefined>(
  limiter: RateLimiter<K>,
  opts: {
    onLimit?: (c: HonoContextLike<K>) => Response | Promise<Response>;
  } = {},
) {
  return async (c: HonoContextLike<K>, next: HonoNext): Promise<Response | void> => {
    // Per-request rebind so observability hooks can use `waitUntil`. The
    // clone is cheap (frozen config swap; no normalisation), and only
    // produced when an executionCtx is actually present. Limiters built
    // without `hookMode: 'wait-until'` see no behaviour change.
    const scoped =
      c.executionCtx !== undefined ? limiter.withExecutionCtx(c.executionCtx) : limiter;
    const result = await scoped.check(c.req.raw);
    c.set('rateLimit', result as unknown);
    if (!result.allowed) {
      if (opts.onLimit !== undefined) return opts.onLimit(c);
      return new Response('Too Many Requests', {
        status: 429,
        headers: result.headers,
      });
    }
    await next();
    // Merge the limiter's headers into the downstream response so clients
    // see the live policy on success too.
    const downstream = c.res;
    if (downstream !== undefined) {
      result.headers.forEach((v, k) => downstream.headers.set(k, v));
    }
  };
}
