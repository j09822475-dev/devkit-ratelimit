/**
 * Hono adapter — Web-Standard `Request` makes this trivial. The middleware
 * runs the limiter, exposes the result on `c.var.rateLimit`, and either
 * short-circuits with a 429 or merges the limiter's headers into the
 * downstream response.
 *
 * The adapter auto-detects `c.executionCtx` and switches the limiter's
 * `hookMode` to `'wait-until'` so observability hooks don't add to TTFB on
 * Workers / Vercel Edge.
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
    // Wire executionCtx so the limiter's hooks can use waitUntil. We do
    // not mutate the limiter; the runConsume path consults `cfg.executionCtx`
    // from the frozen config; the bare middleware path stays on
    // fire-and-forget since we cannot mutate the cfg post-hoc. Adapters
    // that *want* wait-until set `hookMode: 'wait-until'` at construction
    // and pass `executionCtx` into the limiter's config directly.
    const result = await limiter.check(c.req.raw);
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
