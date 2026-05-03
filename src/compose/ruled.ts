/**
 * `ruledRateLimiter` — first-matching-rule wins. Predicates are evaluated
 * top-down. A throwing predicate is bubbled as `INVALID_CONFIG`.
 */

import { RateLimitError } from '../errors/base.js';
import { build429Response } from '../core/response.js';
import { buildHeaders } from '../core/headers.js';
import type { HeaderStyle } from '../types/headers.js';
import type { RateLimiter, RateLimiterMiddleware } from '../types/limiter.js';
import type { RateLimitResult } from '../types/result.js';

/**
 * Single rule entry — predicate plus the limiter to apply when matched.
 */
export interface Rule {
  readonly when: (req: Request) => boolean | Promise<boolean>;
  readonly use: RateLimiter<unknown>;
}

/**
 * Build a rule-based limiter.
 *
 * @param opts.rules    Ordered list of rules.
 * @param opts.fallback Optional catch-all limiter when no rule matches.
 * @returns             A composed {@link RateLimiter}.
 * @throws              `RateLimitError('INVALID_CONFIG')` on empty rules
 *                      with no fallback.
 * @example
 *   const limiter = ruledRateLimiter({
 *     rules: [
 *       { when: (r) => r.method === 'POST', use: writeLimiter },
 *       { when: (r) => r.url.includes('/admin'), use: adminLimiter },
 *     ],
 *     fallback: defaultLimiter,
 *   });
 */
export function ruledRateLimiter(opts: {
  readonly rules: readonly Rule[];
  readonly fallback?: RateLimiter<unknown>;
}): RateLimiter<unknown> {
  if (opts.rules.length === 0 && opts.fallback === undefined) {
    throw new RateLimitError(
      'INVALID_CONFIG',
      'ruledRateLimiter requires at least one rule or a fallback',
    );
  }

  async function pick(req: Request): Promise<RateLimiter<unknown> | null> {
    for (const rule of opts.rules) {
      let matched = false;
      try {
        matched = await rule.when(req);
      } catch (err) {
        throw new RateLimitError('INVALID_CONFIG', 'rule predicate threw', err);
      }
      if (matched) return rule.use;
    }
    return opts.fallback ?? null;
  }

  // For the no-rule-matched synthetic path we mirror the headerStyle of
  // whichever limiter would have been picked first, so clients don't see
  // mixed RFC/legacy header shapes between consume and skip paths.
  function defaultStyle(): HeaderStyle {
    return opts.rules[0]?.use.config.headerStyle ?? opts.fallback?.config.headerStyle ?? 'rfc';
  }

  async function check(
    req: Request,
    opts2?: { cost?: number },
  ): Promise<RateLimitResult<unknown>> {
    const limiter = await pick(req);
    if (limiter === null) {
      const now = Date.now();
      const state = { limit: 0, remaining: 0, reset: now, retryAfter: 0 };
      return {
        allowed: true,
        key: '',
        state,
        headers: buildHeaders(state, defaultStyle(), now),
        degraded: false,
        context: undefined,
      };
    }
    return limiter.check(req, opts2);
  }

  async function peek(req: Request): Promise<RateLimitResult<unknown>> {
    const limiter = await pick(req);
    if (limiter === null) {
      const now = Date.now();
      const state = { limit: 0, remaining: 0, reset: now, retryAfter: 0 };
      return {
        allowed: true,
        key: '',
        state,
        headers: buildHeaders(state, defaultStyle(), now),
        degraded: false,
        context: undefined,
      };
    }
    return limiter.peek(req);
  }

  async function reset(req: Request): Promise<boolean> {
    const limiter = await pick(req);
    return limiter !== null ? limiter.reset(req) : false;
  }

  async function resetKey(key: string): Promise<boolean> {
    const limiters = opts.rules.map((r) => r.use);
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
    return ruledRateLimiter({
      rules: opts.rules.map((r) => ({ when: r.when, use: r.use.withExecutionCtx(executionCtx) })),
      ...(opts.fallback !== undefined
        ? { fallback: opts.fallback.withExecutionCtx(executionCtx) }
        : {}),
    });
  }

  const primary = opts.rules[0]?.use ?? opts.fallback;
  if (primary === undefined) {
    throw new RateLimitError(
      'INVALID_CONFIG',
      'ruledRateLimiter requires a primary limiter',
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
