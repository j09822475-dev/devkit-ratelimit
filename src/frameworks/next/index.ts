/**
 * Next.js App Router adapter — wraps a Route Handler so the limiter runs
 * before the handler executes.
 */

import type { RateLimiter } from '../../types/limiter.js';

/**
 * A Next.js Route Handler signature — request in, `Response` out. Kept
 * narrow so the adapter does not import `next` at runtime.
 */
export type RouteHandler = (
  req: Request,
  ctx?: { params?: Record<string, string | string[] | undefined> },
) => Response | Promise<Response>;

/**
 * Wrap a Route Handler with a limiter — short-circuits with 429 on block,
 * otherwise calls the handler and merges the limiter's headers into the
 * response.
 *
 * @typeParam K Caller-defined context payload type.
 * @typeParam H Handler signature (preserved for inference).
 * @param limiter The {@link RateLimiter} handle.
 * @param handler The Route Handler.
 * @returns       A wrapped Route Handler.
 * @example
 *   import { withRateLimit } from '@devkit/ratelimit/frameworks/next';
 *   export const GET = withRateLimit(limiter, async (req) => Response.json({ ok: true }));
 */
export function withRateLimit<H extends RouteHandler, K = undefined>(
  limiter: RateLimiter<K>,
  handler: H,
): H {
  const wrapped = (async (req, ctx) => {
    const result = await limiter.check(req);
    if (!result.allowed) {
      return new Response('Too Many Requests', {
        status: 429,
        headers: result.headers,
      });
    }
    const response = await handler(req, ctx);
    result.headers.forEach((v, k) => response.headers.set(k, v));
    return response;
  }) as H;
  return wrapped;
}

/**
 * Build a Next.js middleware (App Router) that runs the limiter against
 * incoming requests. Pass an optional matcher to skip routes.
 *
 * @typeParam K Caller-defined context payload type.
 * @param limiter The {@link RateLimiter} handle.
 * @param matcher Optional predicate; only requests where this returns
 *                `true` are rate limited.
 * @returns       A middleware function suitable for `middleware.ts`.
 */
export function rateLimitMiddleware<K = undefined>(
  limiter: RateLimiter<K>,
  matcher?: (req: Request) => boolean,
) {
  return async (req: Request): Promise<Response | undefined> => {
    if (matcher !== undefined && !matcher(req)) return undefined;
    const result = await limiter.check(req);
    if (!result.allowed) {
      return new Response('Too Many Requests', {
        status: 429,
        headers: result.headers,
      });
    }
    return undefined;
  };
}
