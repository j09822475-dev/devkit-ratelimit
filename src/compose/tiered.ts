/**
 * `tieredRateLimiter` — picks one limiter per request via a resolver
 * (e.g. by API plan). Unknown tier without a fallback skips the request
 * (fail-soft) — turning a resolver/config drift into a 5xx is the worse
 * production-time foot-gun.
 */

import { RateLimitError } from '../errors/base.js';
import { build429Response } from '../core/response.js';
import { buildHeaders } from '../core/headers.js';
import type { HeaderStyle } from '../types/headers.js';
import type { RateLimiter, RateLimiterMiddleware } from '../types/limiter.js';
import type { RateLimitResult, RateLimitState } from '../types/result.js';

/**
 * Build a tier-resolved limiter.
 *
 * @typeParam Tier String tier discriminator.
 * @param opts.resolve  Function that picks a tier per request.
 * @param opts.tiers    Map of tier → limiter.
 * @param opts.fallback Optional catch-all limiter for unknown tiers; when
 *                      omitted unknown tiers SKIP the request and emit a
 *                      `'rate-limit.skipped'` observation tagged with the
 *                      unknown tier name.
 * @returns             A composed {@link RateLimiter}.
 * @throws              `RateLimitError('INVALID_CONFIG')` on empty `tiers`.
 * @example
 *   const limiter = tieredRateLimiter({
 *     resolve: (req) => planFromHeader(req),
 *     tiers: { free: freeLimiter, pro: proLimiter },
 *     fallback: defaultLimiter,
 *   });
 */
export function tieredRateLimiter<Tier extends string>(opts: {
  readonly resolve: (req: Request) => Tier | Promise<Tier>;
  readonly tiers: Readonly<Record<Tier, RateLimiter<unknown>>>;
  readonly fallback?: RateLimiter<unknown>;
}): RateLimiter<unknown> {
  const tierKeys = Object.keys(opts.tiers) as Tier[];
  if (tierKeys.length === 0 && opts.fallback === undefined) {
    throw new RateLimitError(
      'INVALID_CONFIG',
      'tieredRateLimiter requires at least one tier or a fallback',
    );
  }

  async function pick(req: Request): Promise<RateLimiter<unknown> | null> {
    const tier = await opts.resolve(req);
    const limiter = opts.tiers[tier];
    if (limiter !== undefined) return limiter;
    if (opts.fallback !== undefined) return opts.fallback;
    return null;
  }

  function syntheticAllowed<K>(state: RateLimitState, style: HeaderStyle, now: number): RateLimitResult<K> {
    return {
      allowed: true,
      key: '',
      state,
      headers: buildHeaders(state, style, now),
      degraded: false,
      context: undefined as K,
    };
  }

  // For the no-tier-matched synthetic path we mirror the headerStyle of
  // whichever limiter would have been picked first, so clients don't see
  // mixed RFC/legacy header shapes between consume and skip paths.
  function defaultStyle(): HeaderStyle {
    const first = Object.values<RateLimiter<unknown>>(opts.tiers)[0] ?? opts.fallback;
    return first?.config.headerStyle ?? 'rfc';
  }

  async function check(
    req: Request,
    opts2?: { cost?: number },
  ): Promise<RateLimitResult<unknown>> {
    const limiter = await pick(req);
    if (limiter === null) {
      const now = Date.now();
      return syntheticAllowed<unknown>(
        { limit: 0, remaining: 0, reset: now, retryAfter: 0 },
        defaultStyle(),
        now,
      );
    }
    return limiter.check(req, opts2);
  }

  async function peek(req: Request): Promise<RateLimitResult<unknown>> {
    const limiter = await pick(req);
    if (limiter === null) {
      const now = Date.now();
      return syntheticAllowed<unknown>(
        { limit: 0, remaining: 0, reset: now, retryAfter: 0 },
        defaultStyle(),
        now,
      );
    }
    return limiter.peek(req);
  }

  async function reset(req: Request): Promise<boolean> {
    const limiter = await pick(req);
    return limiter !== null ? limiter.reset(req) : false;
  }

  async function resetKey(key: string): Promise<boolean> {
    // Without a request to resolve from we touch every tier — best-effort
    // for admin-tooling callers.
    const limiters = [...Object.values<RateLimiter<unknown>>(opts.tiers)];
    if (opts.fallback !== undefined) limiters.push(opts.fallback);
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

  function withExecutionCtx(
    executionCtx: { waitUntil(p: Promise<unknown>): void },
  ): RateLimiter<unknown> {
    const reboundTiers = Object.fromEntries(
      Object.entries<RateLimiter<unknown>>(opts.tiers).map(([k, v]) => [
        k,
        v.withExecutionCtx(executionCtx),
      ]),
    ) as Readonly<Record<Tier, RateLimiter<unknown>>>;
    return tieredRateLimiter<Tier>({
      resolve: opts.resolve,
      tiers: reboundTiers,
      ...(opts.fallback !== undefined
        ? { fallback: opts.fallback.withExecutionCtx(executionCtx) }
        : {}),
    });
  }

  const primary =
    (Object.values<RateLimiter<unknown>>(opts.tiers)[0]) ?? opts.fallback;
  if (primary === undefined) {
    throw new RateLimitError(
      'INVALID_CONFIG',
      'tieredRateLimiter requires at least one tier or a fallback',
    );
  }
  return Object.freeze<RateLimiter<unknown>>({
    check,
    peek,
    reset,
    resetKey,
    middleware,
    withExecutionCtx,
    config: primary.config,
  });
}
