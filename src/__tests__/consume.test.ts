import { describe, expect, it, vi } from 'vitest';
import {
  asState,
  assertValidCost,
  runConsume,
  runPeek,
  specCapacity,
  specWindowMs,
  wrapStoreError,
} from '../core/consume.js';
import { RateLimitError } from '../errors/base.js';
import { fixedWindow } from '../algorithms/fixed-window/index.js';
import { tokenBucket } from '../algorithms/token-bucket/index.js';
import { leakyBucket } from '../algorithms/leaky-bucket/index.js';
import { slidingWindow } from '../algorithms/sliding-window/index.js';
import { slidingWindowLog } from '../algorithms/sliding-window-log/index.js';
import type { RateLimitStore } from '../types/store.js';

const okStore: RateLimitStore = {
  name: 'mock',
  async consume(_k, _s, cost, now) {
    return { allowed: true, limit: 10, remaining: 10 - cost, reset: now + 1000, retryAfter: 0 };
  },
  async peek(_k, _s, now) {
    return { limit: 10, remaining: 10, reset: now + 1000, retryAfter: 0 };
  },
  async reset() {
    return true;
  },
};

const broken = new Error('boom');
const failStore: RateLimitStore = {
  name: 'mock',
  async consume() {
    throw broken;
  },
  async peek() {
    throw broken;
  },
  async reset() {
    return false;
  },
};

describe('assertValidCost', () => {
  it('should accept positive integers', () => {
    expect(() => assertValidCost(1)).not.toThrow();
    expect(() => assertValidCost(100)).not.toThrow();
  });

  it('should accept zero (peek-like)', () => {
    expect(() => assertValidCost(0)).not.toThrow();
  });

  it('should accept positive fractional cost', () => {
    expect(() => assertValidCost(0.5)).not.toThrow();
  });

  it('should throw INVALID_COST on negative', () => {
    expect(() => assertValidCost(-1)).toThrow(RateLimitError);
  });

  it('should throw INVALID_COST on NaN', () => {
    expect(() => assertValidCost(Number.NaN)).toThrow(RateLimitError);
  });

  it('should throw INVALID_COST on Infinity', () => {
    expect(() => assertValidCost(Number.POSITIVE_INFINITY)).toThrow(RateLimitError);
  });

  it('should throw INVALID_COST on non-number', () => {
    expect(() => assertValidCost('1' as unknown as number)).toThrow(RateLimitError);
  });
});

describe('specCapacity', () => {
  it('should return capacity for token-bucket', () => {
    expect(specCapacity(tokenBucket({ capacity: 5, refill: 1, interval: '1s' }))).toBe(5);
  });

  it('should return capacity for leaky-bucket', () => {
    expect(specCapacity(leakyBucket({ capacity: 5, leak: 1, interval: '1s' }))).toBe(5);
  });

  it('should return limit for window-style algorithms', () => {
    expect(specCapacity(fixedWindow({ limit: 7, window: '1m' }))).toBe(7);
    expect(specCapacity(slidingWindow({ limit: 11, window: '1m' }))).toBe(11);
    expect(specCapacity(slidingWindowLog({ limit: 13, window: '1m' }))).toBe(13);
  });
});

describe('specWindowMs', () => {
  it('should return intervalMs for bucket-style algorithms', () => {
    expect(specWindowMs(tokenBucket({ capacity: 1, refill: 1, interval: '1s' }))).toBe(1000);
    expect(specWindowMs(leakyBucket({ capacity: 1, leak: 1, interval: '2s' }))).toBe(2000);
  });

  it('should return windowMs for window-style algorithms', () => {
    expect(specWindowMs(fixedWindow({ limit: 1, window: '1m' }))).toBe(60_000);
  });
});

describe('runConsume', () => {
  it('should pass through store result with degraded:false on success', async () => {
    const r = await runConsume(okStore, 'k', fixedWindow({ limit: 10, window: '1m' }), 1, 1000, false);
    expect(r.allowed).toBe(true);
    expect(r.degraded).toBe(false);
    expect(r.remaining).toBe(9);
  });

  it('should short-circuit cost > capacity without hitting the store', async () => {
    const consumeSpy = vi.fn();
    const store: RateLimitStore = {
      name: 'mock',
      consume: consumeSpy as unknown as RateLimitStore['consume'],
      peek: okStore.peek,
      reset: okStore.reset,
    };
    const r = await runConsume(
      store,
      'k',
      fixedWindow({ limit: 10, window: '1m' }),
      11,
      1000,
      false,
    );
    expect(r.allowed).toBe(false);
    expect(r.limit).toBe(10);
    expect(r.remaining).toBe(0);
    expect(consumeSpy).not.toHaveBeenCalled();
  });

  it('should throw STORE_UNAVAILABLE wrapped error on store throw when fail-closed', async () => {
    await expect(
      runConsume(failStore, 'k', fixedWindow({ limit: 10, window: '1m' }), 1, 1000, false),
    ).rejects.toThrow(RateLimitError);
  });

  it('should return synthetic degraded result on store throw when fail-open', async () => {
    const r = await runConsume(failStore, 'k', fixedWindow({ limit: 10, window: '1m' }), 1, 1000, true);
    expect(r.allowed).toBe(true);
    expect(r.degraded).toBe(true);
    expect(r.limit).toBe(10);
  });

  it('should re-throw an existing RateLimitError untouched', async () => {
    const wrapped = new RateLimitError('INVALID_KEY', 'pre-wrapped');
    const store: RateLimitStore = {
      name: 'mock',
      async consume() {
        throw wrapped;
      },
      async peek() {
        throw wrapped;
      },
      async reset() {
        return false;
      },
    };
    await expect(
      runConsume(store, 'k', fixedWindow({ limit: 10, window: '1m' }), 1, 1000, false),
    ).rejects.toBe(wrapped);
  });
});

describe('runPeek', () => {
  it('should add allowed:true and degraded:false to peek result', async () => {
    const r = await runPeek(okStore, 'k', fixedWindow({ limit: 10, window: '1m' }), 1000, false);
    expect(r.allowed).toBe(true);
    expect(r.degraded).toBe(false);
    expect(r.remaining).toBe(10);
  });

  it('should fail-closed wrap on store throw', async () => {
    await expect(
      runPeek(failStore, 'k', fixedWindow({ limit: 10, window: '1m' }), 1000, false),
    ).rejects.toThrow(RateLimitError);
  });

  it('should fail-open synthesise on store throw', async () => {
    const r = await runPeek(failStore, 'k', fixedWindow({ limit: 10, window: '1m' }), 1000, true);
    expect(r.degraded).toBe(true);
    expect(r.allowed).toBe(true);
  });
});

describe('wrapStoreError', () => {
  it('should pass through an existing RateLimitError', () => {
    const inner = new RateLimitError('INVALID_KEY', 'm');
    const out = wrapStoreError(inner, okStore);
    expect(out).toBe(inner);
  });

  it('should wrap a generic Error in STORE_UNAVAILABLE', () => {
    const out = wrapStoreError(new Error('eek'), okStore);
    expect(out.code).toBe('STORE_UNAVAILABLE');
    expect(out.message).toContain('mock');
  });

  it('should wrap a string-thrown value', () => {
    const out = wrapStoreError('boom', okStore);
    expect(out.code).toBe('STORE_UNAVAILABLE');
    expect(out.message).toContain('string-thrown');
  });

  it('should wrap an unknown thrown value', () => {
    const out = wrapStoreError(42, okStore);
    expect(out.code).toBe('STORE_UNAVAILABLE');
    expect(out.message).toContain('unknown');
  });

  it('should fall back to "store" prefix when store has no name', () => {
    const noName: RateLimitStore = { ...okStore };
    delete (noName as { name?: string }).name;
    const out = wrapStoreError(new Error('e'), noName);
    expect(out.message).toContain('store');
  });
});

describe('asState', () => {
  it('should project pipeline result onto a RateLimitState', () => {
    const r = asState({
      allowed: true,
      limit: 10,
      remaining: 5,
      reset: 100,
      retryAfter: 0,
      degraded: false,
    });
    expect(r).toEqual({ limit: 10, remaining: 5, reset: 100, retryAfter: 0 });
  });
});
