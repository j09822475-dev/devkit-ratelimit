/**
 * `composeAll` — logical AND. Runs every limiter in declaration order;
 * the first to block wins. Layers that allow have already consumed their
 * permit by the time a later layer blocks — the correct semantics for
 * layered quotas (per-IP + per-key + per-tenant).
 */

import { RateLimitError } from '../errors/base.js';
import type { RateLimiter, RateLimiterMiddleware } from '../types/limiter.js';
import type { RateLimitResult } from '../types/result.js';
import { build429Response } from '../core/response.js';

/**
 * Compose a list of limiters with logical-AND semantics.
 *
 * **Side-effect:** prior layers have ALREADY consumed their permit by the
 * time a later layer blocks. This is correct for layered quotas — read
 * the type as "all must allow". For "any one allow short-circuits", use
 * `composeFirstAllowed`.
 *
 * @param limiters Non-empty array of limiters.
 * @returns        A composed {@link RateLimiter}.
 * @throws         `RateLimitError('INVALID_CONFIG')` on empty input.
 * @example
 *   const limiter = composeAll([ipLimiter, keyLimiter, tenantLimiter]);
 */
export function composeAll(limiters: readonly RateLimiter<unknown>[]): RateLimiter<unknown> {
  if (limiters.length === 0) {
    throw new RateLimitError(
      'INVALID_CONFIG',
      'composeAll requires at least one limiter',
    );
  }
  if (limiters.length === 1) return limiters[0] as RateLimiter<unknown>;

  async function check(
    req: Request,
    opts?: { cost?: number },
  ): Promise<RateLimitResult<unknown>> {
    const allowed: RateLimitResult<unknown>[] = [];
    let blocking: RateLimitResult<unknown> | undefined;
    for (const layer of limiters) {
      const result = await layer.check(req, opts);
      if (!result.allowed) {
        blocking = result;
        break;
      }
      allowed.push(result);
    }
    if (blocking !== undefined) {
      // Merge prior allowed-layer headers alongside the blocking layer's
      // so clients see every active policy.
      const merged = new Headers(blocking.headers);
      for (const r of allowed) {
        r.headers.forEach((v, k) => {
          if (k.toLowerCase() === 'retry-after') return;
          merged.append(k, v);
        });
      }
      return { ...blocking, headers: merged };
    }
    // Every layer allowed — return the most restrictive remaining count
    // for the result, with merged headers.
    const last = allowed.at(-1);
    if (last === undefined) {
      throw new RateLimitError('INVALID_CONFIG', 'composeAll: empty allowed set');
    }
    const tightest = allowed.reduce((acc, cur) =>
      cur.state.remaining < acc.state.remaining ? cur : acc,
    );
    const merged = new Headers(tightest.headers);
    for (const r of allowed) {
      if (r === tightest) continue;
      r.headers.forEach((v, k) => {
        if (k.toLowerCase() === 'retry-after') return;
        merged.append(k, v);
      });
    }
    return { ...tightest, headers: merged };
  }

  async function peek(req: Request): Promise<RateLimitResult<unknown>> {
    const peeks = await Promise.all(limiters.map((l) => l.peek(req)));
    const tightest = peeks.reduce((acc, cur) =>
      cur.state.remaining < acc.state.remaining ? cur : acc,
    );
    return tightest;
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

  // Use the first limiter's config as the surface; downstream code
  // typically reads only `prefix` / `algorithm.kind` and a composed
  // limiter's "primary" identity is the first layer.
  const primary = limiters[0];
  if (primary === undefined) {
    throw new RateLimitError('INVALID_CONFIG', 'composeAll: empty primary');
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
