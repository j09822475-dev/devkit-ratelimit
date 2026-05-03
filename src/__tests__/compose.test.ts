import { describe, expect, it } from 'vitest';
import { createMemoryStore } from '../adapters/memory/index.js';
import { fixedWindow } from '../algorithms/fixed-window/index.js';
import {
  composeAll,
  composeFirstAllowed,
  ruledRateLimiter,
  tieredRateLimiter,
} from '../compose/index.js';
import { createRateLimiter } from '../core/limiter.js';
import { RateLimitError } from '../errors/base.js';
import type { RateLimiter } from '../types/limiter.js';

const ip = (addr: string): Request =>
  new Request('https://example.com/x', { headers: { 'x-real-ip': addr } });

const make = (limit: number, headerStyle: 'rfc' | 'legacy' = 'rfc'): RateLimiter<unknown> =>
  createRateLimiter({
    algorithm: fixedWindow({ limit, window: '1m' }),
    store: createMemoryStore({ sweepIntervalMs: 0 }),
    headerStyle,
    clock: () => 0,
  }) as unknown as RateLimiter<unknown>;

describe('composeAll', () => {
  it('should throw INVALID_CONFIG on empty input', () => {
    expect(() => composeAll([])).toThrow(RateLimitError);
  });

  it('should return the single limiter unchanged when length is 1', () => {
    const a = make(2);
    expect(composeAll([a])).toBe(a);
  });

  it('should require ALL limiters to allow', async () => {
    const limiter = composeAll([make(2), make(1)]);
    const r1 = await limiter.check(ip('1.1.1.1'));
    expect(r1.allowed).toBe(true);
    const r2 = await limiter.check(ip('1.1.1.1'));
    expect(r2.allowed).toBe(false);
  });

  it('should return the tightest remaining when all allow', async () => {
    const a = make(10);
    const b = make(3);
    const limiter = composeAll([a, b]);
    const r = await limiter.check(ip('1.1.1.1'));
    expect(r.state.remaining).toBe(2);
  });

  it('should merge headers (excluding Retry-After) on success', async () => {
    const limiter = composeAll([make(5, 'rfc'), make(3, 'legacy')]);
    const r = await limiter.check(ip('1.1.1.1'));
    expect(r.headers.get('RateLimit')).toBeTruthy();
    expect(r.headers.get('X-RateLimit-Limit')).toBeTruthy();
  });

  it('should merge prior allowed-layer headers with the blocking layer', async () => {
    const a = make(2);
    const b = make(1);
    const limiter = composeAll([a, b]);
    await limiter.check(ip('1.1.1.1'));
    const blocked = await limiter.check(ip('1.1.1.1'));
    expect(blocked.allowed).toBe(false);
    expect(blocked.headers.get('Retry-After')).toBeTruthy();
  });

  it('should peek and return the tightest remaining', async () => {
    const a = make(10);
    const b = make(3);
    await a.check(ip('1.1.1.1')); // a now has 9 remaining
    const limiter = composeAll([a, b]);
    const p = await limiter.peek(ip('1.1.1.1'));
    expect(p.state.remaining).toBe(3);
  });

  it('should reset every layer', async () => {
    const a = make(1);
    const b = make(1);
    const limiter = composeAll([a, b]);
    await limiter.check(ip('1.1.1.1'));
    expect(await limiter.reset(ip('1.1.1.1'))).toBe(true);
  });

  it('should resetKey across every layer', async () => {
    const a = make(1);
    const b = make(1);
    const limiter = composeAll([a, b]);
    await limiter.check(ip('1.1.1.1'));
    expect(await limiter.resetKey('1.1.1.1')).toBe(true);
  });

  it('should expose the first limiter config as primary', () => {
    const a = make(5);
    const b = make(3);
    const limiter = composeAll([a, b]);
    expect(limiter.config).toBe(a.config);
  });

  it('should provide a middleware that returns 429 on block', async () => {
    const limiter = composeAll([make(1), make(1)]);
    const m = limiter.middleware();
    await m(ip('1.1.1.1'));
    const blocked = await m(ip('1.1.1.1'));
    expect(blocked!.status).toBe(429);
  });

  it('should middleware return undefined on allow', async () => {
    const limiter = composeAll([make(2), make(2)]);
    const m = limiter.middleware();
    expect(await m(ip('1.1.1.1'))).toBeUndefined();
  });

  it('should propagate executionCtx via withExecutionCtx', () => {
    const a = make(1);
    const b = make(1);
    const composed = composeAll([a, b]);
    const ctx = { waitUntil: () => undefined };
    const scoped = composed.withExecutionCtx(ctx);
    expect(scoped).not.toBe(composed);
  });
});

describe('composeFirstAllowed', () => {
  it('should throw INVALID_CONFIG on empty input', () => {
    expect(() => composeFirstAllowed([])).toThrow(RateLimitError);
  });

  it('should return the single limiter unchanged when length is 1', () => {
    const a = make(2);
    expect(composeFirstAllowed([a])).toBe(a);
  });

  it('should short-circuit on the first allow', async () => {
    const a = make(1);
    const b = make(1);
    // 1st call: a allows, b not consulted.
    const limiter = composeFirstAllowed([a, b]);
    const r1 = await limiter.check(ip('1.1.1.1'));
    expect(r1.allowed).toBe(true);
    // a's permit consumed; verify b still has its own permit.
    const r = await b.check(ip('1.1.1.1'));
    expect(r.allowed).toBe(true);
    expect(r.state.remaining).toBe(0);
  });

  it('should allow via the next layer when the first blocks', async () => {
    const a = make(1);
    const b = make(2);
    const limiter = composeFirstAllowed([a, b]);
    await a.check(ip('1.1.1.1')); // exhaust a manually
    const r = await limiter.check(ip('1.1.1.1'));
    expect(r.allowed).toBe(true);
  });

  it('should return the result with the soonest retryAfter when every layer blocks', async () => {
    const a = make(1);
    const b = make(1);
    await a.check(ip('1.1.1.1'));
    await b.check(ip('1.1.1.1'));
    const limiter = composeFirstAllowed([a, b]);
    const r = await limiter.check(ip('1.1.1.1'));
    expect(r.allowed).toBe(false);
    expect(r.state.retryAfter).toBeGreaterThan(0);
  });

  it('should peek and return the highest remaining', async () => {
    const a = make(2);
    const b = make(5);
    const limiter = composeFirstAllowed([a, b]);
    const p = await limiter.peek(ip('1.1.1.1'));
    expect(p.state.remaining).toBe(5);
  });

  it('should reset across layers', async () => {
    const a = make(1);
    const b = make(1);
    await a.check(ip('1.1.1.1'));
    const limiter = composeFirstAllowed([a, b]);
    expect(await limiter.reset(ip('1.1.1.1'))).toBe(true);
  });

  it('should resetKey across layers', async () => {
    const a = make(1);
    const b = make(1);
    await a.check(ip('1.1.1.1'));
    const limiter = composeFirstAllowed([a, b]);
    expect(await limiter.resetKey('1.1.1.1')).toBe(true);
  });

  it('should middleware short-circuit with 429 when every layer blocks', async () => {
    const a = make(1);
    const b = make(1);
    await a.check(ip('1.1.1.1'));
    await b.check(ip('1.1.1.1'));
    const limiter = composeFirstAllowed([a, b]);
    const m = limiter.middleware();
    const blocked = await m(ip('1.1.1.1'));
    expect(blocked!.status).toBe(429);
  });

  it('should propagate executionCtx via withExecutionCtx', () => {
    const composed = composeFirstAllowed([make(1), make(1)]);
    const scoped = composed.withExecutionCtx({ waitUntil: () => undefined });
    expect(scoped).not.toBe(composed);
  });
});

describe('tieredRateLimiter', () => {
  it('should require at least one tier or fallback', () => {
    expect(() =>
      tieredRateLimiter({
        resolve: () => 'x',
        tiers: {} as Record<string, RateLimiter<unknown>>,
      }),
    ).toThrow(RateLimitError);
  });

  it('should pick the resolved tier for the request', async () => {
    const free = make(1);
    const pro = make(5);
    const limiter = tieredRateLimiter({
      resolve: (req: Request) => (req.headers.get('x-plan') === 'pro' ? 'pro' : 'free'),
      tiers: { free, pro },
    });
    const proReq = new Request('https://example.com/', {
      headers: { 'x-real-ip': '1.1.1.1', 'x-plan': 'pro' },
    });
    const r = await limiter.check(proReq);
    expect(r.state.limit).toBe(5);
  });

  it('should fall back to fallback limiter on unknown tier', async () => {
    const fallback = make(7);
    const limiter = tieredRateLimiter<'free' | 'pro'>({
      resolve: () => 'unknown' as never,
      tiers: { free: make(1), pro: make(2) },
      fallback,
    });
    const r = await limiter.check(ip('1.1.1.1'));
    expect(r.state.limit).toBe(7);
  });

  it('should synthesise a skipped result on unknown tier without fallback', async () => {
    const limiter = tieredRateLimiter<'free'>({
      resolve: () => 'never' as never,
      tiers: { free: make(1) },
    });
    const r = await limiter.check(ip('1.1.1.1'));
    expect(r.allowed).toBe(true);
    expect(r.key).toBe('');
  });

  it('should peek through the picked tier', async () => {
    const free = make(2);
    const limiter = tieredRateLimiter<'free'>({
      resolve: () => 'free',
      tiers: { free },
    });
    const p = await limiter.peek(ip('1.1.1.1'));
    expect(p.state.limit).toBe(2);
  });

  it('should peek synthesise on unknown tier', async () => {
    const limiter = tieredRateLimiter<'free'>({
      resolve: () => 'unknown' as never,
      tiers: { free: make(1) },
    });
    const p = await limiter.peek(ip('1.1.1.1'));
    expect(p.allowed).toBe(true);
  });

  it('should reset through the picked tier', async () => {
    const free = make(1);
    const limiter = tieredRateLimiter<'free'>({
      resolve: () => 'free',
      tiers: { free },
    });
    await limiter.check(ip('1.1.1.1'));
    expect(await limiter.reset(ip('1.1.1.1'))).toBe(true);
  });

  it('should return false on reset for unknown tier without fallback', async () => {
    const limiter = tieredRateLimiter<'free'>({
      resolve: () => 'unknown' as never,
      tiers: { free: make(1) },
    });
    expect(await limiter.reset(ip('1.1.1.1'))).toBe(false);
  });

  it('should resetKey across every tier (admin tooling path)', async () => {
    const free = make(1);
    const pro = make(1);
    const limiter = tieredRateLimiter<'free' | 'pro'>({
      resolve: () => 'free',
      tiers: { free, pro },
    });
    await free.check(ip('1.1.1.1'));
    await pro.check(ip('1.1.1.1'));
    expect(await limiter.resetKey('1.1.1.1')).toBe(true);
  });

  it('should middleware return 429 when picked tier blocks', async () => {
    const free = make(1);
    const limiter = tieredRateLimiter<'free'>({
      resolve: () => 'free',
      tiers: { free },
    });
    const m = limiter.middleware();
    await m(ip('1.1.1.1'));
    const blocked = await m(ip('1.1.1.1'));
    expect(blocked!.status).toBe(429);
  });

  it('should expose the first tier limiter config as primary', () => {
    const free = make(1);
    const pro = make(2);
    const limiter = tieredRateLimiter<'free' | 'pro'>({
      resolve: () => 'free',
      tiers: { free, pro },
    });
    expect(limiter.config).toBe(free.config);
  });

  it('should propagate executionCtx via withExecutionCtx', () => {
    const limiter = tieredRateLimiter<'free'>({
      resolve: () => 'free',
      tiers: { free: make(1) },
      fallback: make(1),
    });
    const scoped = limiter.withExecutionCtx({ waitUntil: () => undefined });
    expect(scoped).not.toBe(limiter);
  });

  it('should use first-tier headerStyle for synthetic skipped result', async () => {
    const free = make(1, 'legacy');
    const limiter = tieredRateLimiter<'free'>({
      resolve: () => 'unknown' as never,
      tiers: { free },
    });
    const r = await limiter.check(ip('1.1.1.1'));
    expect(r.headers.get('X-RateLimit-Limit')).toBe('0');
    expect(r.headers.get('RateLimit')).toBeNull();
  });
});

describe('ruledRateLimiter', () => {
  it('should require at least one rule or fallback', () => {
    expect(() => ruledRateLimiter({ rules: [] })).toThrow(RateLimitError);
  });

  it('should pick the first matching rule', async () => {
    const writeLimiter = make(1);
    const readLimiter = make(5);
    const limiter = ruledRateLimiter({
      rules: [
        { when: (req) => req.method === 'POST', use: writeLimiter },
        { when: () => true, use: readLimiter },
      ],
    });
    const r = await limiter.check(
      new Request('https://example.com/', {
        method: 'POST',
        headers: { 'x-real-ip': '1.1.1.1' },
      }),
    );
    expect(r.state.limit).toBe(1);
  });

  it('should fall back when no rule matches', async () => {
    const fallback = make(7);
    const limiter = ruledRateLimiter({
      rules: [{ when: () => false, use: make(1) }],
      fallback,
    });
    const r = await limiter.check(ip('1.1.1.1'));
    expect(r.state.limit).toBe(7);
  });

  it('should synthesise a skipped result when no rule matches and no fallback', async () => {
    const limiter = ruledRateLimiter({
      rules: [{ when: () => false, use: make(1) }],
    });
    const r = await limiter.check(ip('1.1.1.1'));
    expect(r.allowed).toBe(true);
    expect(r.key).toBe('');
  });

  it('should bubble predicate throws as INVALID_CONFIG', async () => {
    const limiter = ruledRateLimiter({
      rules: [
        {
          when: () => {
            throw new Error('predicate broke');
          },
          use: make(1),
        },
      ],
      fallback: make(1),
    });
    await expect(limiter.check(ip('1.1.1.1'))).rejects.toThrow(RateLimitError);
  });

  it('should peek through the matched rule', async () => {
    const limiter = ruledRateLimiter({
      rules: [{ when: () => true, use: make(2) }],
    });
    const p = await limiter.peek(ip('1.1.1.1'));
    expect(p.state.limit).toBe(2);
  });

  it('should peek synthesise on no match', async () => {
    const limiter = ruledRateLimiter({
      rules: [{ when: () => false, use: make(1) }],
    });
    const p = await limiter.peek(ip('1.1.1.1'));
    expect(p.allowed).toBe(true);
  });

  it('should reset through the matched rule', async () => {
    const limiter = ruledRateLimiter({
      rules: [{ when: () => true, use: make(1) }],
    });
    await limiter.check(ip('1.1.1.1'));
    expect(await limiter.reset(ip('1.1.1.1'))).toBe(true);
  });

  it('should reset return false when no rule matches', async () => {
    const limiter = ruledRateLimiter({
      rules: [{ when: () => false, use: make(1) }],
    });
    expect(await limiter.reset(ip('1.1.1.1'))).toBe(false);
  });

  it('should resetKey across every rule', async () => {
    const a = make(1);
    const b = make(1);
    await a.check(ip('1.1.1.1'));
    const limiter = ruledRateLimiter({
      rules: [
        { when: () => false, use: a },
        { when: () => false, use: b },
      ],
      fallback: make(1),
    });
    expect(await limiter.resetKey('1.1.1.1')).toBe(true);
  });

  it('should middleware return 429 when picked limiter blocks', async () => {
    const limiter = ruledRateLimiter({
      rules: [{ when: () => true, use: make(1) }],
    });
    const m = limiter.middleware();
    await m(ip('1.1.1.1'));
    const blocked = await m(ip('1.1.1.1'));
    expect(blocked!.status).toBe(429);
  });

  it('should middleware return undefined on allow', async () => {
    const limiter = ruledRateLimiter({
      rules: [{ when: () => true, use: make(2) }],
    });
    const m = limiter.middleware();
    expect(await m(ip('1.1.1.1'))).toBeUndefined();
  });

  it('should expose first rule limiter config as primary', () => {
    const a = make(1);
    const b = make(2);
    const limiter = ruledRateLimiter({
      rules: [
        { when: () => false, use: a },
        { when: () => true, use: b },
      ],
    });
    expect(limiter.config).toBe(a.config);
  });

  it('should propagate executionCtx via withExecutionCtx', () => {
    const limiter = ruledRateLimiter({
      rules: [{ when: () => true, use: make(1) }],
      fallback: make(1),
    });
    const scoped = limiter.withExecutionCtx({ waitUntil: () => undefined });
    expect(scoped).not.toBe(limiter);
  });

  it('should use first-rule headerStyle for synthetic skipped result', async () => {
    const limiter = ruledRateLimiter({
      rules: [{ when: () => false, use: make(1, 'legacy') }],
    });
    const r = await limiter.check(ip('1.1.1.1'));
    expect(r.headers.get('X-RateLimit-Limit')).toBe('0');
  });
});
