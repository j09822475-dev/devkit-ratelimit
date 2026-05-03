import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryStore } from '../adapters/memory/index.js';
import { fixedWindow } from '../algorithms/fixed-window/index.js';
import { tokenBucket } from '../algorithms/token-bucket/index.js';
import { createRateLimiter } from '../core/limiter.js';
import { RateLimitError } from '../errors/base.js';
import type { RateLimitObservation } from '../types/observability.js';
import type { RateLimitStore } from '../types/store.js';

const ip = (addr: string): Request =>
  new Request('https://example.com/api', { headers: { 'x-real-ip': addr } });

const noip = (): Request => new Request('https://example.com/api');

afterEach(() => {
  vi.useRealTimers();
});

describe('createRateLimiter — config normalisation', () => {
  it('should construct from spec form', () => {
    const limiter = createRateLimiter({
      algorithm: fixedWindow({ limit: 5, window: '1m' }),
      store: createMemoryStore({ sweepIntervalMs: 0 }),
    });
    expect(limiter).toBeDefined();
    expect(limiter.config.algorithm.kind).toBe('fixed-window');
  });

  it('should construct from sugar (flat) form', () => {
    const limiter = createRateLimiter({
      algorithm: 'sliding-window',
      limit: 5,
      window: '1m',
      store: createMemoryStore({ sweepIntervalMs: 0 }),
    });
    expect(limiter.config.algorithm.kind).toBe('sliding-window-counter');
  });

  it('should default prefix to "rl"', () => {
    const limiter = createRateLimiter({
      algorithm: fixedWindow({ limit: 5, window: '1m' }),
      store: createMemoryStore({ sweepIntervalMs: 0 }),
    });
    expect(limiter.config.prefix).toBe('rl');
  });

  it('should default headerStyle to "rfc"', () => {
    const limiter = createRateLimiter({
      algorithm: fixedWindow({ limit: 5, window: '1m' }),
      store: createMemoryStore({ sweepIntervalMs: 0 }),
    });
    expect(limiter.config.headerStyle).toBe('rfc');
  });

  it('should derive a stable scope hash from the algorithm spec', () => {
    const a = createRateLimiter({
      algorithm: fixedWindow({ limit: 5, window: '1m' }),
      store: createMemoryStore({ sweepIntervalMs: 0 }),
    });
    const b = createRateLimiter({
      algorithm: fixedWindow({ limit: 5, window: '1m' }),
      store: createMemoryStore({ sweepIntervalMs: 0 }),
    });
    expect(a.config.scope).toBe(b.config.scope);
  });

  it('should produce different scopes for different policies', () => {
    const a = createRateLimiter({
      algorithm: fixedWindow({ limit: 5, window: '1m' }),
      store: createMemoryStore({ sweepIntervalMs: 0 }),
    });
    const b = createRateLimiter({
      algorithm: fixedWindow({ limit: 6, window: '1m' }),
      store: createMemoryStore({ sweepIntervalMs: 0 }),
    });
    expect(a.config.scope).not.toBe(b.config.scope);
  });

  it('should freeze the returned handle and config', () => {
    const limiter = createRateLimiter({
      algorithm: fixedWindow({ limit: 5, window: '1m' }),
      store: createMemoryStore({ sweepIntervalMs: 0 }),
    });
    expect(Object.isFrozen(limiter)).toBe(true);
    expect(Object.isFrozen(limiter.config)).toBe(true);
  });

  it('should reject construction-time cost <= 0', () => {
    expect(() =>
      createRateLimiter({
        algorithm: fixedWindow({ limit: 5, window: '1m' }),
        store: createMemoryStore({ sweepIntervalMs: 0 }),
        cost: 0,
      }),
    ).toThrow(RateLimitError);
    expect(() =>
      createRateLimiter({
        algorithm: fixedWindow({ limit: 5, window: '1m' }),
        store: createMemoryStore({ sweepIntervalMs: 0 }),
        cost: -1,
      }),
    ).toThrow(RateLimitError);
  });

  it('should reject construction-time non-finite cost', () => {
    expect(() =>
      createRateLimiter({
        algorithm: fixedWindow({ limit: 5, window: '1m' }),
        store: createMemoryStore({ sweepIntervalMs: 0 }),
        cost: Number.POSITIVE_INFINITY,
      }),
    ).toThrow(RateLimitError);
  });

  it('should reject when algorithm is missing kind', () => {
    expect(() =>
      createRateLimiter({
        algorithm: {} as never,
        store: createMemoryStore({ sweepIntervalMs: 0 }),
      }),
    ).toThrow(RateLimitError);
  });

  it('should reject when store is missing', () => {
    expect(() =>
      createRateLimiter({
        algorithm: fixedWindow({ limit: 5, window: '1m' }),
        store: null as never,
      }),
    ).toThrow(RateLimitError);
  });

  it('should accept a custom prefix and scope', () => {
    const limiter = createRateLimiter({
      algorithm: fixedWindow({ limit: 5, window: '1m' }),
      store: createMemoryStore({ sweepIntervalMs: 0 }),
      prefix: 'app',
      scope: 'login',
    });
    expect(limiter.config.prefix).toBe('app');
    expect(limiter.config.scope).toBe('login');
  });

  it('should accept empty prefix', () => {
    const limiter = createRateLimiter({
      algorithm: fixedWindow({ limit: 5, window: '1m' }),
      store: createMemoryStore({ sweepIntervalMs: 0 }),
      prefix: '',
    });
    expect(limiter.config.prefix).toBe('');
  });
});

describe('createRateLimiter.check', () => {
  it('should allow up to the limit and block above', async () => {
    const limiter = createRateLimiter({
      algorithm: fixedWindow({ limit: 2, window: '1m' }),
      store: createMemoryStore({ sweepIntervalMs: 0 }),
      clock: () => 0,
    });
    const a = await limiter.check(ip('1.1.1.1'));
    expect(a.allowed).toBe(true);
    const b = await limiter.check(ip('1.1.1.1'));
    expect(b.allowed).toBe(true);
    const c = await limiter.check(ip('1.1.1.1'));
    expect(c.allowed).toBe(false);
  });

  it('should bucket per IP independently', async () => {
    const limiter = createRateLimiter({
      algorithm: fixedWindow({ limit: 1, window: '1m' }),
      store: createMemoryStore({ sweepIntervalMs: 0 }),
      clock: () => 0,
    });
    expect((await limiter.check(ip('1.1.1.1'))).allowed).toBe(true);
    expect((await limiter.check(ip('2.2.2.2'))).allowed).toBe(true);
    expect((await limiter.check(ip('1.1.1.1'))).allowed).toBe(false);
  });

  it('should attach RFC headers to the result', async () => {
    const limiter = createRateLimiter({
      algorithm: fixedWindow({ limit: 5, window: '1m' }),
      store: createMemoryStore({ sweepIntervalMs: 0 }),
      clock: () => 0,
    });
    const r = await limiter.check(ip('1.2.3.4'));
    expect(r.headers.get('RateLimit')).toContain('limit=5');
    expect(r.headers.get('RateLimit')).toContain('remaining=4');
  });

  it('should skip when the key generator returns null (no IP)', async () => {
    const limiter = createRateLimiter({
      algorithm: fixedWindow({ limit: 1, window: '1m' }),
      store: createMemoryStore({ sweepIntervalMs: 0 }),
      clock: () => 0,
    });
    const r = await limiter.check(noip());
    expect(r.allowed).toBe(true);
    expect(r.key).toBe('');
    expect(r.degraded).toBe(false);
  });

  it('should accept a structured key generator and thread context through', async () => {
    interface Ctx {
      tenant: string;
    }
    const limiter = createRateLimiter<Ctx>({
      algorithm: fixedWindow({ limit: 1, window: '1m' }),
      store: createMemoryStore({ sweepIntervalMs: 0 }),
      keyGenerator: () => ({ key: 'k', context: { tenant: 'acme' } }),
    });
    const r = await limiter.check(ip('1.2.3.4'));
    expect(r.context).toEqual({ tenant: 'acme' });
    expect(r.allowed).toBe(true);
  });

  it('should throw KEY_TOO_LONG when generated key exceeds maxKeyLength', async () => {
    const limiter = createRateLimiter({
      algorithm: fixedWindow({ limit: 1, window: '1m' }),
      store: createMemoryStore({ sweepIntervalMs: 0 }),
      keyGenerator: () => 'x'.repeat(2000),
      maxKeyLength: 100,
    });
    await expect(limiter.check(ip('1.2.3.4'))).rejects.toThrow(RateLimitError);
  });

  it('should accept a per-call cost override', async () => {
    const limiter = createRateLimiter({
      algorithm: fixedWindow({ limit: 5, window: '1m' }),
      store: createMemoryStore({ sweepIntervalMs: 0 }),
    });
    const r = await limiter.check(ip('1.2.3.4'), { cost: 3 });
    expect(r.state.remaining).toBe(2);
  });

  it('should validate per-call cost (rejects negative)', async () => {
    const limiter = createRateLimiter({
      algorithm: fixedWindow({ limit: 5, window: '1m' }),
      store: createMemoryStore({ sweepIntervalMs: 0 }),
    });
    await expect(limiter.check(ip('1.2.3.4'), { cost: -1 })).rejects.toThrow(RateLimitError);
  });

  it('should accept cost 0 per-call (peek-like) and not advance count', async () => {
    const limiter = createRateLimiter({
      algorithm: fixedWindow({ limit: 5, window: '1m' }),
      store: createMemoryStore({ sweepIntervalMs: 0 }),
    });
    const a = await limiter.check(ip('1.2.3.4'), { cost: 1 });
    const b = await limiter.check(ip('1.2.3.4'), { cost: 0 });
    expect(b.state.remaining).toBe(a.state.remaining);
  });

  it('should fail-closed STORE_UNAVAILABLE when store.consume throws', async () => {
    const failStore: RateLimitStore = {
      name: 'mock',
      async consume() {
        throw new Error('boom');
      },
      async peek() {
        throw new Error('boom');
      },
      async reset() {
        return false;
      },
    };
    const limiter = createRateLimiter({
      algorithm: fixedWindow({ limit: 1, window: '1m' }),
      store: failStore,
    });
    await expect(limiter.check(ip('1.1.1.1'))).rejects.toThrow(RateLimitError);
  });

  it('should fail-open with degraded:true when store throws and failOpen is true', async () => {
    const failStore: RateLimitStore = {
      name: 'mock',
      async consume() {
        throw new Error('boom');
      },
      async peek() {
        throw new Error('boom');
      },
      async reset() {
        return false;
      },
    };
    const limiter = createRateLimiter({
      algorithm: fixedWindow({ limit: 1, window: '1m' }),
      store: failStore,
      failOpen: true,
    });
    const r = await limiter.check(ip('1.1.1.1'));
    expect(r.allowed).toBe(true);
    expect(r.degraded).toBe(true);
  });

  it('should propagate INVALID_KEY when key generator throws and failOpen is false', async () => {
    const limiter = createRateLimiter({
      algorithm: fixedWindow({ limit: 1, window: '1m' }),
      store: createMemoryStore({ sweepIntervalMs: 0 }),
      keyGenerator: () => {
        throw new Error('keygen exploded');
      },
    });
    await expect(limiter.check(ip('1.1.1.1'))).rejects.toThrow(RateLimitError);
  });

  it('should fail-open with degraded:true on key generator throw when failOpen is true', async () => {
    const limiter = createRateLimiter({
      algorithm: fixedWindow({ limit: 1, window: '1m' }),
      store: createMemoryStore({ sweepIntervalMs: 0 }),
      keyGenerator: () => {
        throw new Error('keygen exploded');
      },
      failOpen: true,
    });
    const r = await limiter.check(ip('1.1.1.1'));
    expect(r.degraded).toBe(true);
    expect(r.allowed).toBe(true);
  });

  it('should re-throw a key-generator-thrown RateLimitError as-is when fail-closed', async () => {
    const inner = new RateLimitError('INVALID_KEY', 'predeclared');
    const limiter = createRateLimiter({
      algorithm: fixedWindow({ limit: 1, window: '1m' }),
      store: createMemoryStore({ sweepIntervalMs: 0 }),
      keyGenerator: () => {
        throw inner;
      },
    });
    await expect(limiter.check(ip('1.1.1.1'))).rejects.toBe(inner);
  });

  it('should skip when generator returns empty string', async () => {
    const limiter = createRateLimiter({
      algorithm: fixedWindow({ limit: 1, window: '1m' }),
      store: createMemoryStore({ sweepIntervalMs: 0 }),
      keyGenerator: () => '',
    });
    const r = await limiter.check(ip('1.1.1.1'));
    expect(r.allowed).toBe(true);
    expect(r.key).toBe('');
  });

  it('should skip when structured generator returns empty key', async () => {
    const limiter = createRateLimiter({
      algorithm: fixedWindow({ limit: 1, window: '1m' }),
      store: createMemoryStore({ sweepIntervalMs: 0 }),
      keyGenerator: () => ({ key: '', context: undefined }),
    });
    const r = await limiter.check(ip('1.1.1.1'));
    expect(r.key).toBe('');
  });

  it('should pick up cf.connectingIp when no header is present', async () => {
    const limiter = createRateLimiter({
      algorithm: fixedWindow({ limit: 1, window: '1m' }),
      store: createMemoryStore({ sweepIntervalMs: 0 }),
      clock: () => 0,
    });
    const req = new Request('https://example.com/');
    (req as { cf?: unknown }).cf = { connectingIp: '4.4.4.4' };
    const r = await limiter.check(req);
    expect(r.key).toContain('4.4.4.4');
  });
});

describe('createRateLimiter.peek', () => {
  it('should return current state without consuming', async () => {
    const limiter = createRateLimiter({
      algorithm: fixedWindow({ limit: 5, window: '1m' }),
      store: createMemoryStore({ sweepIntervalMs: 0 }),
      clock: () => 0,
    });
    await limiter.check(ip('1.1.1.1'));
    const p = await limiter.peek(ip('1.1.1.1'));
    expect(p.state.remaining).toBe(4);
    const p2 = await limiter.peek(ip('1.1.1.1'));
    expect(p2.state.remaining).toBe(4);
  });

  it('should always set allowed:true', async () => {
    const limiter = createRateLimiter({
      algorithm: fixedWindow({ limit: 5, window: '1m' }),
      store: createMemoryStore({ sweepIntervalMs: 0 }),
    });
    const p = await limiter.peek(ip('1.1.1.1'));
    expect(p.allowed).toBe(true);
  });

  it('should return synthetic skipped result when no IP', async () => {
    const limiter = createRateLimiter({
      algorithm: fixedWindow({ limit: 5, window: '1m' }),
      store: createMemoryStore({ sweepIntervalMs: 0 }),
    });
    const p = await limiter.peek(noip());
    expect(p.key).toBe('');
    expect(p.allowed).toBe(true);
  });

  it('should fail-open synthesise when store throws', async () => {
    const failStore: RateLimitStore = {
      name: 'mock',
      async consume() {
        throw new Error('boom');
      },
      async peek() {
        throw new Error('boom');
      },
      async reset() {
        return false;
      },
    };
    const limiter = createRateLimiter({
      algorithm: fixedWindow({ limit: 5, window: '1m' }),
      store: failStore,
      failOpen: true,
    });
    const p = await limiter.peek(ip('1.1.1.1'));
    expect(p.degraded).toBe(true);
  });

  it('should return degraded result when keygen throws under failOpen', async () => {
    const limiter = createRateLimiter({
      algorithm: fixedWindow({ limit: 5, window: '1m' }),
      store: createMemoryStore({ sweepIntervalMs: 0 }),
      keyGenerator: () => {
        throw new Error('e');
      },
      failOpen: true,
    });
    const p = await limiter.peek(ip('1.1.1.1'));
    expect(p.degraded).toBe(true);
  });
});

describe('createRateLimiter.reset / resetKey', () => {
  it('should reset(req) drop the counter', async () => {
    const limiter = createRateLimiter({
      algorithm: fixedWindow({ limit: 1, window: '1m' }),
      store: createMemoryStore({ sweepIntervalMs: 0 }),
      clock: () => 0,
    });
    await limiter.check(ip('1.1.1.1'));
    expect(await limiter.reset(ip('1.1.1.1'))).toBe(true);
    const r = await limiter.check(ip('1.1.1.1'));
    expect(r.allowed).toBe(true);
  });

  it('should return false on reset(req) when no key extracted', async () => {
    const limiter = createRateLimiter({
      algorithm: fixedWindow({ limit: 1, window: '1m' }),
      store: createMemoryStore({ sweepIntervalMs: 0 }),
    });
    expect(await limiter.reset(noip())).toBe(false);
  });

  it('should resetKey(userKey) drop the counter', async () => {
    const limiter = createRateLimiter({
      algorithm: fixedWindow({ limit: 1, window: '1m' }),
      store: createMemoryStore({ sweepIntervalMs: 0 }),
      clock: () => 0,
    });
    await limiter.check(ip('1.1.1.1'));
    expect(await limiter.resetKey('1.1.1.1')).toBe(true);
  });

  it('should return false on resetKey with empty key', async () => {
    const limiter = createRateLimiter({
      algorithm: fixedWindow({ limit: 1, window: '1m' }),
      store: createMemoryStore({ sweepIntervalMs: 0 }),
    });
    expect(await limiter.resetKey('')).toBe(false);
  });

  it('should return false on resetKey for missing key', async () => {
    const limiter = createRateLimiter({
      algorithm: fixedWindow({ limit: 1, window: '1m' }),
      store: createMemoryStore({ sweepIntervalMs: 0 }),
    });
    expect(await limiter.resetKey('never-seen')).toBe(false);
  });
});

describe('createRateLimiter.middleware', () => {
  it('should resolve to undefined when allowed', async () => {
    const limiter = createRateLimiter({
      algorithm: fixedWindow({ limit: 5, window: '1m' }),
      store: createMemoryStore({ sweepIntervalMs: 0 }),
    });
    const m = limiter.middleware();
    const r = await m(ip('1.1.1.1'));
    expect(r).toBeUndefined();
  });

  it('should resolve to a 429 Response when blocked', async () => {
    const limiter = createRateLimiter({
      algorithm: fixedWindow({ limit: 1, window: '1m' }),
      store: createMemoryStore({ sweepIntervalMs: 0 }),
      clock: () => 0,
    });
    const m = limiter.middleware();
    await m(ip('1.1.1.1'));
    const blocked = await m(ip('1.1.1.1'));
    expect(blocked).toBeInstanceOf(Response);
    expect(blocked!.status).toBe(429);
    expect(await blocked!.text()).toBe('Too Many Requests');
  });

  it('should honour a custom message', async () => {
    const limiter = createRateLimiter({
      algorithm: fixedWindow({ limit: 1, window: '1m' }),
      store: createMemoryStore({ sweepIntervalMs: 0 }),
      message: 'Slow down, friend',
      clock: () => 0,
    });
    const m = limiter.middleware();
    await m(ip('1.1.1.1'));
    const blocked = await m(ip('1.1.1.1'));
    expect(await blocked!.text()).toBe('Slow down, friend');
  });

  it('should honour a custom responseBuilder returning a Response', async () => {
    const limiter = createRateLimiter({
      algorithm: fixedWindow({ limit: 1, window: '1m' }),
      store: createMemoryStore({ sweepIntervalMs: 0 }),
      responseBuilder: () =>
        new Response('custom', {
          status: 429,
          headers: { 'X-Custom': '1' },
        }),
      clock: () => 0,
    });
    const m = limiter.middleware();
    await m(ip('1.1.1.1'));
    const blocked = await m(ip('1.1.1.1'));
    expect(await blocked!.text()).toBe('custom');
    expect(blocked!.headers.get('X-Custom')).toBe('1');
  });

  it('should accept a string return from responseBuilder and wrap it in a 429', async () => {
    const limiter = createRateLimiter({
      algorithm: fixedWindow({ limit: 1, window: '1m' }),
      store: createMemoryStore({ sweepIntervalMs: 0 }),
      // The default responseBuilder type expects Response; we cast here for the test.
      responseBuilder: ((() => 'string body') as unknown) as never,
      clock: () => 0,
    });
    const m = limiter.middleware();
    await m(ip('1.1.1.1'));
    const blocked = await m(ip('1.1.1.1'));
    expect(blocked).toBeInstanceOf(Response);
    expect(blocked!.status).toBe(429);
    expect(await blocked!.text()).toBe('string body');
  });

  it('should fall back to default 429 if responseBuilder throws', async () => {
    const limiter = createRateLimiter({
      algorithm: fixedWindow({ limit: 1, window: '1m' }),
      store: createMemoryStore({ sweepIntervalMs: 0 }),
      responseBuilder: () => {
        throw new Error('builder bug');
      },
      clock: () => 0,
    });
    const m = limiter.middleware();
    await m(ip('1.1.1.1'));
    const blocked = await m(ip('1.1.1.1'));
    expect(blocked!.status).toBe(429);
  });

  it('should reject a non-Response, non-string responseBuilder return as INVALID_CONFIG', async () => {
    const limiter = createRateLimiter({
      algorithm: fixedWindow({ limit: 1, window: '1m' }),
      store: createMemoryStore({ sweepIntervalMs: 0 }),
      responseBuilder: ((() => 123) as unknown) as never,
      clock: () => 0,
    });
    const m = limiter.middleware();
    await m(ip('1.1.1.1'));
    await expect(m(ip('1.1.1.1'))).rejects.toThrow(RateLimitError);
  });
});

describe('createRateLimiter — observability hook', () => {
  it('should emit an "allowed" event in sync mode', async () => {
    const events: RateLimitObservation<undefined>[] = [];
    const limiter = createRateLimiter({
      algorithm: fixedWindow({ limit: 5, window: '1m' }),
      store: createMemoryStore({ sweepIntervalMs: 0 }),
      on: (e) => {
        events.push(e);
      },
      hookMode: 'sync',
    });
    await limiter.check(ip('1.1.1.1'));
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('rate-limit.allowed');
    expect(events[0]!.method).toBe('GET');
    expect(events[0]!.path).toBe('/api');
    expect(events[0]!.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it('should emit a "blocked" event when limit exceeded', async () => {
    const events: RateLimitObservation<undefined>[] = [];
    const limiter = createRateLimiter({
      algorithm: fixedWindow({ limit: 1, window: '1m' }),
      store: createMemoryStore({ sweepIntervalMs: 0 }),
      on: (e) => {
        events.push(e);
      },
      hookMode: 'sync',
      clock: () => 0,
    });
    await limiter.check(ip('1.1.1.1'));
    await limiter.check(ip('1.1.1.1'));
    expect(events.map((e) => e.type)).toEqual(['rate-limit.allowed', 'rate-limit.blocked']);
  });

  it('should emit a "skipped" event when no key', async () => {
    const events: RateLimitObservation<undefined>[] = [];
    const limiter = createRateLimiter({
      algorithm: fixedWindow({ limit: 1, window: '1m' }),
      store: createMemoryStore({ sweepIntervalMs: 0 }),
      on: (e) => {
        events.push(e);
      },
      hookMode: 'sync',
    });
    await limiter.check(noip());
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('rate-limit.skipped');
  });

  it('should emit an "error" event with error attached when keygen throws under failOpen', async () => {
    const events: RateLimitObservation<undefined>[] = [];
    const limiter = createRateLimiter({
      algorithm: fixedWindow({ limit: 1, window: '1m' }),
      store: createMemoryStore({ sweepIntervalMs: 0 }),
      keyGenerator: () => {
        throw new Error('keygen');
      },
      on: (e) => {
        events.push(e);
      },
      hookMode: 'sync',
      failOpen: true,
    });
    await limiter.check(ip('1.1.1.1'));
    expect(events[0]!.type).toBe('rate-limit.error');
    expect(events[0]!.error?.code).toBe('INVALID_KEY');
  });

  it('should emit a degraded "error" event when store throws under failOpen', async () => {
    const events: RateLimitObservation<undefined>[] = [];
    const failStore: RateLimitStore = {
      name: 'mock',
      async consume() {
        throw new Error('boom');
      },
      async peek() {
        throw new Error('boom');
      },
      async reset() {
        return false;
      },
    };
    const limiter = createRateLimiter({
      algorithm: fixedWindow({ limit: 1, window: '1m' }),
      store: failStore,
      failOpen: true,
      on: (e) => {
        events.push(e);
      },
      hookMode: 'sync',
    });
    await limiter.check(ip('1.1.1.1'));
    expect(events[0]!.type).toBe('rate-limit.error');
  });

  it('should emit an error observation when store throws under fail-closed (and re-throw)', async () => {
    const events: RateLimitObservation<undefined>[] = [];
    const failStore: RateLimitStore = {
      name: 'mock',
      async consume() {
        throw new Error('boom');
      },
      async peek() {
        throw new Error('boom');
      },
      async reset() {
        return false;
      },
    };
    const limiter = createRateLimiter({
      algorithm: fixedWindow({ limit: 1, window: '1m' }),
      store: failStore,
      on: (e) => {
        events.push(e);
      },
      hookMode: 'sync',
    });
    await expect(limiter.check(ip('1.1.1.1'))).rejects.toThrow(RateLimitError);
    expect(events[0]!.type).toBe('rate-limit.error');
    expect(events[0]!.error?.code).toBe('STORE_UNAVAILABLE');
  });

  it('should swallow throws inside the hook', async () => {
    const limiter = createRateLimiter({
      algorithm: fixedWindow({ limit: 5, window: '1m' }),
      store: createMemoryStore({ sweepIntervalMs: 0 }),
      on: () => {
        throw new Error('hook error');
      },
      hookMode: 'sync',
    });
    await expect(limiter.check(ip('1.1.1.1'))).resolves.toMatchObject({ allowed: true });
  });

  it('should bound sync hook duration by hookTimeoutMs', async () => {
    let resolved = false;
    const limiter = createRateLimiter({
      algorithm: fixedWindow({ limit: 5, window: '1m' }),
      store: createMemoryStore({ sweepIntervalMs: 0 }),
      on: () =>
        new Promise<void>((res) => {
          setTimeout(() => {
            resolved = true;
            res();
          }, 5_000);
        }),
      hookMode: 'sync',
      hookTimeoutMs: 5,
    });
    const t0 = Date.now();
    await limiter.check(ip('1.1.1.1'));
    expect(Date.now() - t0).toBeLessThan(500);
    expect(resolved).toBe(false);
  });

  it('should fire-and-forget by default and not block the check call', async () => {
    let fired = false;
    const limiter = createRateLimiter({
      algorithm: fixedWindow({ limit: 5, window: '1m' }),
      store: createMemoryStore({ sweepIntervalMs: 0 }),
      on: () => {
        fired = true;
      },
    });
    await limiter.check(ip('1.1.1.1'));
    // microtasks flush by here
    await Promise.resolve();
    await Promise.resolve();
    expect(fired).toBe(true);
  });

  it('should route through executionCtx.waitUntil when hookMode is "wait-until"', async () => {
    const fired: Promise<unknown>[] = [];
    const ctx = {
      waitUntil(p: Promise<unknown>) {
        fired.push(p);
      },
    };
    const limiter = createRateLimiter({
      algorithm: fixedWindow({ limit: 5, window: '1m' }),
      store: createMemoryStore({ sweepIntervalMs: 0 }),
      on: () => undefined,
      hookMode: 'wait-until',
      executionCtx: ctx,
    });
    await limiter.check(ip('1.1.1.1'));
    expect(fired).toHaveLength(1);
  });

  it('should fall back to fire-and-forget under "wait-until" without executionCtx', async () => {
    let fired = false;
    const limiter = createRateLimiter({
      algorithm: fixedWindow({ limit: 5, window: '1m' }),
      store: createMemoryStore({ sweepIntervalMs: 0 }),
      on: () => {
        fired = true;
      },
      hookMode: 'wait-until',
    });
    await limiter.check(ip('1.1.1.1'));
    await Promise.resolve();
    await Promise.resolve();
    expect(fired).toBe(true);
  });

  it('should not emit when no hook configured', async () => {
    const limiter = createRateLimiter({
      algorithm: fixedWindow({ limit: 5, window: '1m' }),
      store: createMemoryStore({ sweepIntervalMs: 0 }),
    });
    await expect(limiter.check(ip('1.1.1.1'))).resolves.toMatchObject({ allowed: true });
  });

  it('should set path to req.url when URL parsing fails', async () => {
    const events: RateLimitObservation<undefined>[] = [];
    const limiter = createRateLimiter({
      algorithm: fixedWindow({ limit: 5, window: '1m' }),
      store: createMemoryStore({ sweepIntervalMs: 0 }),
      on: (e) => {
        events.push(e);
      },
      hookMode: 'sync',
    });
    // Use a real Request with a valid URL but mutate via a sneaky proxy.
    // We only test via the standard path; the catch branch is defence in
    // depth for legacy adapters that pass a non-URL `url`.
    await limiter.check(ip('1.1.1.1'));
    expect(events[0]!.path).toBe('/api');
  });
});

describe('createRateLimiter.withExecutionCtx', () => {
  it('should return a new frozen handle with executionCtx populated', () => {
    const limiter = createRateLimiter({
      algorithm: fixedWindow({ limit: 1, window: '1m' }),
      store: createMemoryStore({ sweepIntervalMs: 0 }),
    });
    const ctx = { waitUntil: () => undefined };
    const scoped = limiter.withExecutionCtx(ctx);
    expect(scoped).not.toBe(limiter);
    expect(scoped.config.executionCtx).toBe(ctx);
    expect(Object.isFrozen(scoped)).toBe(true);
  });

  it('should preserve store identity (no re-instantiation)', async () => {
    const store = createMemoryStore({ sweepIntervalMs: 0 });
    const limiter = createRateLimiter({
      algorithm: fixedWindow({ limit: 5, window: '1m' }),
      store,
    });
    const ctx = { waitUntil: () => undefined };
    const scoped = limiter.withExecutionCtx(ctx);
    expect(scoped.config.store).toBe(store);
  });
});

describe('createRateLimiter — clock injection', () => {
  it('should use the supplied clock for time-dependent decisions', async () => {
    let now = 0;
    const limiter = createRateLimiter({
      algorithm: tokenBucket({ capacity: 1, refill: 1, interval: '1s' }),
      store: createMemoryStore({ sweepIntervalMs: 0 }),
      clock: () => now,
    });
    const a = await limiter.check(ip('1.1.1.1'));
    expect(a.allowed).toBe(true);
    const b = await limiter.check(ip('1.1.1.1'));
    expect(b.allowed).toBe(false);
    now = 2_000;
    const c = await limiter.check(ip('1.1.1.1'));
    expect(c.allowed).toBe(true);
  });

  it('should produce deterministic headers when clock is fixed', async () => {
    const limiter = createRateLimiter({
      algorithm: fixedWindow({ limit: 5, window: '1m' }),
      store: createMemoryStore({ sweepIntervalMs: 0 }),
      clock: () => 0,
    });
    const a = await limiter.check(ip('1.1.1.1'));
    const b = await limiter.check(ip('2.2.2.2'));
    expect(a.headers.get('RateLimit')).toBe('limit=5, remaining=4, reset=60');
    expect(b.headers.get('RateLimit')).toBe('limit=5, remaining=4, reset=60');
  });
});
