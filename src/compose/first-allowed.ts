/**
 * `composeFirstAllowed` — logical OR with short-circuit on the first
 * allow. Tries each limiter in declaration order; subsequent layers do
 * NOT consume their permits.
 */

import { RateLimitError } from '../errors/base.js';
import { build429Response } from '../core/response.js';
import type { RateLimiter, RateLimiterMiddleware } from '../types/limiter.js';
import type { RateLimitResult } from '../types/result.js';

/**
 * Compose a list of limiters with logical-OR semantics. If every layer
 * blocks, returns the result from the layer with the soonest
 * `retryAfter` so the client gets the most actionable wait.
 *
 * @param limiters Non-empty array of limiters.
 * @returns        A composed {@link RateLimiter}.
 * @throws         `RateLimitError('INVALID_CONFIG')` on empty input.
 * @example
 *   const limiter = composeFirstAllowed([apiKeyLimiter, ipLimiter]);
 */
export function composeFirstAllowed(
  limiters: readonly RateLimiter<unknown>[],
): RateLimiter<unknown> {
  if (limiters.length === 0) {
    throw new RateLimitError(
      'INVALID_CONFIG',
      'composeFirstAllowed requires at least one limiter',
    );
  }
  if (limiters.length === 1) return limiters[0] as RateLimiter<unknown>;

  async function check(
    req: Request,
    opts?: { cost?: number },
  ): Promise<RateLimitResult<unknown>> {
    const blocked: RateLimitResult<unknown>[] = [];
    for (const layer of limiters) {
      const result = await layer.check(req, opts);
      if (result.allowed) return result;
      blocked.push(result);
    }
    // Every layer blocked — return the one with the soonest retryAfter.
    const soonest = blocked.reduce((acc, cur) =>
      cur.state.retryAfter < acc.state.retryAfter ? cur : acc,
    );
    return soonest;
  }

  async function peek(req: Request): Promise<RateLimitResult<unknown>> {
    const peeks = await Promise.all(limiters.map((l) => l.peek(req)));
    const best = peeks.reduce((acc, cur) =>
      cur.state.remaining > acc.state.remaining ? cur : acc,
    );
    return best;
  }

  async function reset(req: Request): Promise<boolean> {
    const results = await Promise.all(limiters.map((l) => l.reset(req)));
    return results.some((b) => b);
  }

  async function resetKey(key: string): Promise<boolean> {
    const results = await Promise.all(limiters.map((l) => l.resetKey(key)));
    return results.some((b) => b);
  }

  function middleware(): RateLimiterMiddleware {
    return async (req: Request) => {
      const result = await check(req);
      if (result.allowed) return undefined;
      return build429Response(result, 'Too Many Requests');
    };
  }

  const primary = limiters[0];
  if (primary === undefined) {
    throw new RateLimitError('INVALID_CONFIG', 'composeFirstAllowed: empty primary');
  }
  return Object.freeze<RateLimiter<unknown>>({
    check,
    peek,
    reset,
    resetKey,
    middleware,
    config: primary.config as RateLimiter<unknown>['config'],
  });
}
