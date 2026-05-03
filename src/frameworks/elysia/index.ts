/**
 * Elysia plugin — Web-Standard `Request` flows through Elysia's
 * `request` lifecycle, so the adapter is a tiny `onRequest` hook that
 * short-circuits with a 429 or stamps the result onto `store.rateLimit`
 * for downstream handlers.
 */

import type { RateLimiter } from '../../types/limiter.js';
import type { RateLimitResult } from '../../types/result.js';

/**
 * Loose Elysia context shape — kept narrow so the adapter does not import
 * the `elysia` package as a runtime dependency.
 */
interface ElysiaCtxLike<K> {
  request: Request;
  set: { headers: Record<string, string>; status?: number };
  store: { rateLimit?: RateLimitResult<K> } & Record<string, unknown>;
}

/**
 * Build an Elysia `onRequest` handler. Returns the 429 `Response` directly
 * when blocked; resolves to `undefined` otherwise so the request continues.
 *
 * @typeParam K Caller-defined context payload type.
 * @param limiter The {@link RateLimiter} handle.
 * @returns       An Elysia request hook.
 * @example
 *   import { elysiaRateLimit } from '@devkit/ratelimit/frameworks/elysia';
 *   app.onRequest(elysiaRateLimit(limiter));
 */
export function elysiaRateLimit<K = undefined>(limiter: RateLimiter<K>) {
  return async (ctx: ElysiaCtxLike<K>): Promise<Response | undefined> => {
    const result = await limiter.check(ctx.request);
    ctx.store.rateLimit = result;
    // Merge the limiter's headers into the response set for downstream.
    result.headers.forEach((v, k) => {
      ctx.set.headers[k] = v;
    });
    if (!result.allowed) {
      ctx.set.status = 429;
      return new Response('Too Many Requests', {
        status: 429,
        headers: result.headers,
      });
    }
    return undefined;
  };
}
