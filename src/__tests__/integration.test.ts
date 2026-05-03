import { describe, expect, it } from 'vitest';
import { createMemoryStore } from '../adapters/memory/index.js';
import { fixedWindow } from '../algorithms/fixed-window/index.js';
import { leakyBucket } from '../algorithms/leaky-bucket/index.js';
import { slidingWindow } from '../algorithms/sliding-window/index.js';
import { slidingWindowLog } from '../algorithms/sliding-window-log/index.js';
import { tokenBucket } from '../algorithms/token-bucket/index.js';
import { composeAll, composeFirstAllowed } from '../compose/index.js';
import { tieredRateLimiter } from '../compose/tiered.js';
import { ruledRateLimiter } from '../compose/ruled.js';
import { honoRateLimit } from '../frameworks/hono/index.js';
import {
  composeKey,
  createRateLimiter,
  defaultKeyGenerator,
  parseDuration,
  RateLimitError,
} from '../index.js';

const ipReq = (ip: string, path = '/api'): Request =>
  new Request(`https://example.com${path}`, { headers: { 'x-real-ip': ip } });

describe('public index re-exports', () => {
  it('should expose createRateLimiter', () => {
    expect(typeof createRateLimiter).toBe('function');
  });

  it('should expose defaultKeyGenerator and composeKey', () => {
    expect(typeof defaultKeyGenerator).toBe('function');
    expect(composeKey('a', 'b', 'c')).toBe('a:b:c');
  });

  it('should expose parseDuration', () => {
    expect(parseDuration('1m')).toBe(60_000);
  });

  it('should expose RateLimitError', () => {
    expect(typeof RateLimitError).toBe('function');
    expect(new RateLimitError('INVALID_CONFIG', 'msg').code).toBe('INVALID_CONFIG');
  });
});

describe('end-to-end: each algorithm via memory + limiter', () => {
  const make = (algorithm: ReturnType<typeof fixedWindow>) =>
    createRateLimiter({
      algorithm,
      store: createMemoryStore({ sweepIntervalMs: 0 }),
      clock: () => 0,
    });

  it('should produce consistent results through fixed-window', async () => {
    const limiter = make(fixedWindow({ limit: 3, window: '1m' }));
    expect((await limiter.check(ipReq('1.1.1.1'))).allowed).toBe(true);
    expect((await limiter.check(ipReq('1.1.1.1'))).allowed).toBe(true);
    expect((await limiter.check(ipReq('1.1.1.1'))).allowed).toBe(true);
    const blocked = await limiter.check(ipReq('1.1.1.1'));
    expect(blocked.allowed).toBe(false);
    expect(blocked.headers.get('Retry-After')).toBeTruthy();
  });

  it('should produce consistent results through sliding-window', async () => {
    const limiter = createRateLimiter({
      algorithm: slidingWindow({ limit: 2, window: '1m' }),
      store: createMemoryStore({ sweepIntervalMs: 0 }),
    });
    expect((await limiter.check(ipReq('1.1.1.1'))).allowed).toBe(true);
    expect((await limiter.check(ipReq('1.1.1.1'))).allowed).toBe(true);
    expect((await limiter.check(ipReq('1.1.1.1'))).allowed).toBe(false);
  });

  it('should produce consistent results through sliding-window-log', async () => {
    const limiter = createRateLimiter({
      algorithm: slidingWindowLog({ limit: 2, window: '1m' }),
      store: createMemoryStore({ sweepIntervalMs: 0 }),
    });
    expect((await limiter.check(ipReq('1.1.1.1'))).allowed).toBe(true);
    expect((await limiter.check(ipReq('1.1.1.1'))).allowed).toBe(true);
    expect((await limiter.check(ipReq('1.1.1.1'))).allowed).toBe(false);
  });

  it('should produce consistent results through token-bucket', async () => {
    let now = 0;
    const limiter = createRateLimiter({
      algorithm: tokenBucket({ capacity: 2, refill: 2, interval: '1s' }),
      store: createMemoryStore({ sweepIntervalMs: 0 }),
      clock: () => now,
    });
    expect((await limiter.check(ipReq('1.1.1.1'))).allowed).toBe(true);
    expect((await limiter.check(ipReq('1.1.1.1'))).allowed).toBe(true);
    expect((await limiter.check(ipReq('1.1.1.1'))).allowed).toBe(false);
    now = 2_000;
    expect((await limiter.check(ipReq('1.1.1.1'))).allowed).toBe(true);
  });

  it('should produce consistent results through leaky-bucket', async () => {
    let now = 0;
    const limiter = createRateLimiter({
      algorithm: leakyBucket({ capacity: 2, leak: 2, interval: '1s' }),
      store: createMemoryStore({ sweepIntervalMs: 0 }),
      clock: () => now,
    });
    expect((await limiter.check(ipReq('1.1.1.1'))).allowed).toBe(true);
    expect((await limiter.check(ipReq('1.1.1.1'))).allowed).toBe(true);
    expect((await limiter.check(ipReq('1.1.1.1'))).allowed).toBe(false);
    now = 2_000;
    expect((await limiter.check(ipReq('1.1.1.1'))).allowed).toBe(true);
  });
});

describe('end-to-end: sugar form construction', () => {
  it('should build a working limiter from flat config (sliding-window)', async () => {
    const limiter = createRateLimiter({
      algorithm: 'sliding-window',
      limit: 2,
      window: '1m',
      store: createMemoryStore({ sweepIntervalMs: 0 }),
    });
    expect((await limiter.check(ipReq('1.1.1.1'))).allowed).toBe(true);
    expect((await limiter.check(ipReq('1.1.1.1'))).allowed).toBe(true);
    expect((await limiter.check(ipReq('1.1.1.1'))).allowed).toBe(false);
  });

  it('should build a working limiter from flat config (token-bucket)', async () => {
    const limiter = createRateLimiter({
      algorithm: 'token-bucket',
      capacity: 1,
      refill: 1,
      interval: '1s',
      store: createMemoryStore({ sweepIntervalMs: 0 }),
    });
    expect((await limiter.check(ipReq('1.1.1.1'))).allowed).toBe(true);
    expect((await limiter.check(ipReq('1.1.1.1'))).allowed).toBe(false);
  });

  it('should build a working limiter from flat config (fixed-window)', async () => {
    const limiter = createRateLimiter({
      algorithm: 'fixed-window',
      limit: 1,
      window: '1m',
      store: createMemoryStore({ sweepIntervalMs: 0 }),
    });
    expect((await limiter.check(ipReq('1.1.1.1'))).allowed).toBe(true);
    expect((await limiter.check(ipReq('1.1.1.1'))).allowed).toBe(false);
  });

  it('should build a working limiter from flat config (leaky-bucket)', async () => {
    const limiter = createRateLimiter({
      algorithm: 'leaky-bucket',
      capacity: 1,
      leak: 1,
      interval: '1s',
      store: createMemoryStore({ sweepIntervalMs: 0 }),
    });
    expect((await limiter.check(ipReq('1.1.1.1'))).allowed).toBe(true);
    expect((await limiter.check(ipReq('1.1.1.1'))).allowed).toBe(false);
  });

  it('should build a working limiter from flat config (sliding-window-log)', async () => {
    const limiter = createRateLimiter({
      algorithm: 'sliding-window-log',
      limit: 1,
      window: '1m',
      store: createMemoryStore({ sweepIntervalMs: 0 }),
    });
    expect((await limiter.check(ipReq('1.1.1.1'))).allowed).toBe(true);
    expect((await limiter.check(ipReq('1.1.1.1'))).allowed).toBe(false);
  });
});

describe('end-to-end: composition + framework adapter', () => {
  it('should compose two limiters and run them via Hono adapter', async () => {
    const ipLimit = createRateLimiter({
      algorithm: fixedWindow({ limit: 5, window: '1m' }),
      store: createMemoryStore({ sweepIntervalMs: 0 }),
      clock: () => 0,
    });
    const apiLimit = createRateLimiter({
      algorithm: fixedWindow({ limit: 1, window: '1m' }),
      store: createMemoryStore({ sweepIntervalMs: 0 }),
      clock: () => 0,
    });
    const composed = composeAll([ipLimit, apiLimit]);
    const middleware = honoRateLimit(composed);
    const ctxFor = (): {
      req: { raw: Request };
      res?: Response;
      set: (k: string, v: unknown) => void;
      get: (k: 'rateLimit') => unknown;
    } => {
      const ctx = {
        req: { raw: ipReq('1.1.1.1') },
        res: undefined as Response | undefined,
        store: new Map<string, unknown>(),
        set(this: { store: Map<string, unknown> }, k: string, v: unknown) {
          this.store.set(k, v);
        },
        get(this: { store: Map<string, unknown> }, k: 'rateLimit') {
          return this.store.get(k) as unknown;
        },
      };
      return ctx;
    };
    const next = async () => undefined;
    expect(await middleware(ctxFor() as never, next)).toBeUndefined();
    const blocked = await middleware(ctxFor() as never, next);
    expect((blocked as Response).status).toBe(429);
  });

  it('should compose with composeFirstAllowed and route by API key', async () => {
    const ipLim = createRateLimiter({
      algorithm: fixedWindow({ limit: 1, window: '1m' }),
      store: createMemoryStore({ sweepIntervalMs: 0 }),
      clock: () => 0,
    });
    const keyLim = createRateLimiter({
      algorithm: fixedWindow({ limit: 100, window: '1m' }),
      store: createMemoryStore({ sweepIntervalMs: 0 }),
      keyGenerator: (req) => req.headers.get('x-api-key') ?? '',
      clock: () => 0,
    });
    const composed = composeFirstAllowed([keyLim, ipLim]);
    const reqWithKey = (): Request =>
      new Request('https://example.com/', {
        headers: { 'x-real-ip': '1.1.1.1', 'x-api-key': 'paid-customer' },
      });
    // First two calls — keyLim allows both even though ipLim would block the second.
    expect((await composed.check(reqWithKey())).allowed).toBe(true);
    expect((await composed.check(reqWithKey())).allowed).toBe(true);
  });

  it('should pick the correct tier for each request', async () => {
    const free = createRateLimiter({
      algorithm: fixedWindow({ limit: 1, window: '1m' }),
      store: createMemoryStore({ sweepIntervalMs: 0 }),
      clock: () => 0,
    });
    const pro = createRateLimiter({
      algorithm: fixedWindow({ limit: 100, window: '1m' }),
      store: createMemoryStore({ sweepIntervalMs: 0 }),
      clock: () => 0,
    });
    const limiter = tieredRateLimiter<'free' | 'pro'>({
      resolve: (req) => (req.headers.get('x-plan') === 'pro' ? 'pro' : 'free'),
      tiers: { free, pro },
    });
    const freeReq = new Request('https://example.com/', {
      headers: { 'x-real-ip': '1.1.1.1' },
    });
    const proReq = new Request('https://example.com/', {
      headers: { 'x-real-ip': '1.1.1.1', 'x-plan': 'pro' },
    });
    expect((await limiter.check(freeReq)).state.limit).toBe(1);
    expect((await limiter.check(proReq)).state.limit).toBe(100);
  });

  it('should run a write-vs-read rule split end-to-end', async () => {
    const writes = createRateLimiter({
      algorithm: fixedWindow({ limit: 1, window: '1m' }),
      store: createMemoryStore({ sweepIntervalMs: 0 }),
      clock: () => 0,
    });
    const reads = createRateLimiter({
      algorithm: fixedWindow({ limit: 100, window: '1m' }),
      store: createMemoryStore({ sweepIntervalMs: 0 }),
      clock: () => 0,
    });
    const limiter = ruledRateLimiter({
      rules: [
        { when: (req) => req.method === 'POST', use: writes },
        { when: () => true, use: reads },
      ],
    });
    const post = new Request('https://example.com/', {
      method: 'POST',
      headers: { 'x-real-ip': '1.1.1.1' },
    });
    const get = new Request('https://example.com/', {
      headers: { 'x-real-ip': '1.1.1.1' },
    });
    expect((await limiter.check(post)).allowed).toBe(true);
    expect((await limiter.check(post)).allowed).toBe(false);
    // reads allow many
    for (let i = 0; i < 50; i++) {
      expect((await limiter.check(get)).allowed).toBe(true);
    }
  });
});

describe('end-to-end: headers carry the live policy onto every result', () => {
  it('should expose RFC headers on success and 429 alike', async () => {
    const limiter = createRateLimiter({
      algorithm: fixedWindow({ limit: 1, window: '1m' }),
      store: createMemoryStore({ sweepIntervalMs: 0 }),
      clock: () => 0,
    });
    const ok = await limiter.check(ipReq('1.1.1.1'));
    expect(ok.headers.get('RateLimit')).toContain('remaining=0');
    const blocked = await limiter.check(ipReq('1.1.1.1'));
    expect(blocked.headers.get('Retry-After')).toBeTruthy();
  });

  it('should support legacy header style end-to-end', async () => {
    const limiter = createRateLimiter({
      algorithm: fixedWindow({ limit: 1, window: '1m' }),
      store: createMemoryStore({ sweepIntervalMs: 0 }),
      headerStyle: 'legacy',
      clock: () => 0,
    });
    const r = await limiter.check(ipReq('1.1.1.1'));
    expect(r.headers.get('X-RateLimit-Limit')).toBe('1');
  });

  it('should support both styles end-to-end', async () => {
    const limiter = createRateLimiter({
      algorithm: fixedWindow({ limit: 1, window: '1m' }),
      store: createMemoryStore({ sweepIntervalMs: 0 }),
      headerStyle: 'both',
      clock: () => 0,
    });
    const r = await limiter.check(ipReq('1.1.1.1'));
    expect(r.headers.get('X-RateLimit-Limit')).toBe('1');
    expect(r.headers.get('RateLimit')).toBeTruthy();
  });

  it('should support none header style end-to-end', async () => {
    const limiter = createRateLimiter({
      algorithm: fixedWindow({ limit: 1, window: '1m' }),
      store: createMemoryStore({ sweepIntervalMs: 0 }),
      headerStyle: 'none',
      clock: () => 0,
    });
    const r = await limiter.check(ipReq('1.1.1.1'));
    expect(r.headers.get('X-RateLimit-Limit')).toBeNull();
    expect(r.headers.get('RateLimit')).toBeNull();
  });
});

describe('end-to-end: cost > capacity short-circuit', () => {
  it('should block immediately without touching the store', async () => {
    let storeCalls = 0;
    const inner = createMemoryStore({ sweepIntervalMs: 0 });
    const wrapped = {
      ...inner,
      async consume(...args: Parameters<typeof inner.consume>) {
        storeCalls++;
        return inner.consume(...args);
      },
    };
    const limiter = createRateLimiter({
      algorithm: fixedWindow({ limit: 5, window: '1m' }),
      store: wrapped,
    });
    const r = await limiter.check(ipReq('1.1.1.1'), { cost: 100 });
    expect(r.allowed).toBe(false);
    expect(storeCalls).toBe(0);
  });
});
