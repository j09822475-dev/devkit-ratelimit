/**
 * SvelteKit `handle` hook adapter — runs the limiter on every request,
 * short-circuits with 429 on block.
 */

import type { RateLimiter } from '../../types/limiter.js';

/**
 * SvelteKit handle event shape — kept narrow so the adapter does not
 * import `@sveltejs/kit` at runtime. Compatible with SvelteKit v2.
 */
export interface SvelteKitEvent {
  request: Request;
  locals: Record<string, unknown>;
  platform?: { context?: { waitUntil(p: Promise<unknown>): void } };
}

/**
 * SvelteKit handle signature.
 */
export type SvelteKitHandle = (input: {
  event: SvelteKitEvent;
  resolve: (event: SvelteKitEvent) => Promise<Response>;
}) => Promise<Response>;

/**
 * Build a SvelteKit `handle` hook. Stamps the result onto
 * `event.locals.rateLimit` for downstream load functions to read.
 *
 * @typeParam K Caller-defined context payload type.
 * @param limiter The {@link RateLimiter} handle.
 * @returns       A SvelteKit handle suitable for `src/hooks.server.ts`.
 * @example
 *   import { rateLimitHandle } from '@devkit/ratelimit/frameworks/sveltekit';
 *   export const handle = rateLimitHandle(limiter);
 */
export function rateLimitHandle<K = undefined>(limiter: RateLimiter<K>): SvelteKitHandle {
  return async ({ event, resolve }) => {
    // Adapter binding (Vercel / Cloudflare) surfaces `executionCtx` on
    // `event.platform?.context` — rebind the limiter per request so
    // `hookMode: 'wait-until'` actually fires through `waitUntil`.
    const ctx = event.platform?.context;
    const scoped = ctx !== undefined ? limiter.withExecutionCtx(ctx) : limiter;
    const result = await scoped.check(event.request);
    event.locals['rateLimit'] = result;
    if (!result.allowed) {
      return new Response('Too Many Requests', {
        status: 429,
        headers: result.headers,
      });
    }
    const response = await resolve(event);
    result.headers.forEach((v, k) => response.headers.set(k, v));
    return response;
  };
}
