import { describe, expect, it } from 'vitest';
import { createKVStore, type KVLike } from '../adapters/cloudflare-kv/index.js';
import { fixedWindow } from '../algorithms/fixed-window/index.js';
import { leakyBucket } from '../algorithms/leaky-bucket/index.js';
import { slidingWindow } from '../algorithms/sliding-window/index.js';
import { slidingWindowLog } from '../algorithms/sliding-window-log/index.js';
import { tokenBucket } from '../algorithms/token-bucket/index.js';
import { RateLimitError } from '../errors/base.js';
import { brand, type AlgorithmSpec } from '../types/algorithm.js';

const makeKV = (): KVLike & { __store: Map<string, string> } => {
  const data = new Map<string, string>();
  return {
    __store: data,
    async get(key) {
      const v = data.get(key);
      return v === undefined ? null : (JSON.parse(v) as unknown);
    },
    async put(key, value) {
      data.set(key, value);
    },
    async delete(key) {
      data.delete(key);
    },
  };
};

describe('createKVStore — fixed-window', () => {
  const spec = fixedWindow({ limit: 3, window: '1m' });

  it('should allow up to limit and block above', async () => {
    const store = createKVStore(makeKV());
    const r1 = await store.consume('k', spec, 1, 0);
    expect(r1.allowed).toBe(true);
    const r2 = await store.consume('k', spec, 2, 100);
    expect(r2.allowed).toBe(true);
    const r3 = await store.consume('k', spec, 1, 200);
    expect(r3.allowed).toBe(false);
  });

  it('should reset at the window boundary', async () => {
    const store = createKVStore(makeKV());
    await store.consume('k', spec, 3, 0);
    const r = await store.consume('k', spec, 1, 60_000);
    expect(r.allowed).toBe(true);
  });

  it('should peek without persisting state', async () => {
    const kv = makeKV();
    const store = createKVStore(kv);
    const p = await store.peek('k', spec, 0);
    expect(p.remaining).toBe(3);
    expect(kv.__store.size).toBe(0);
  });
});

describe('createKVStore — sliding-window-counter', () => {
  const spec = slidingWindow({ limit: 4, window: '1m' });

  it('should approximate count using previous window', async () => {
    const store = createKVStore(makeKV());
    await store.consume('k', spec, 4, 0);
    const r = await store.consume('k', spec, 1, 60_000);
    expect(r.allowed).toBe(false);
  });

  it('should peek the current state', async () => {
    const store = createKVStore(makeKV());
    await store.consume('k', spec, 2, 0);
    const p = await store.peek('k', spec, 100);
    expect(p.remaining).toBe(2);
  });
});

describe('createKVStore — sliding-window-log', () => {
  const spec = slidingWindowLog({ limit: 3, window: '1m' });

  it('should track exact timestamps', async () => {
    const store = createKVStore(makeKV());
    await store.consume('k', spec, 1, 0);
    await store.consume('k', spec, 1, 1000);
    const r = await store.consume('k', spec, 2, 2000);
    expect(r.allowed).toBe(false);
  });

  it('should drop expired timestamps', async () => {
    const store = createKVStore(makeKV());
    await store.consume('k', spec, 3, 0);
    const r = await store.consume('k', spec, 1, 60_001);
    expect(r.allowed).toBe(true);
  });
});

describe('createKVStore — token-bucket', () => {
  const spec = tokenBucket({ capacity: 3, refill: 3, interval: '1s' });

  it('should refill over time', async () => {
    const store = createKVStore(makeKV());
    await store.consume('k', spec, 3, 0);
    const r = await store.consume('k', spec, 3, 1000);
    expect(r.allowed).toBe(true);
  });

  it('should peek without persisting on cost 0', async () => {
    const kv = makeKV();
    const store = createKVStore(kv);
    await store.peek('k', spec, 0);
    expect(kv.__store.size).toBe(0);
  });
});

describe('createKVStore — leaky-bucket', () => {
  const spec = leakyBucket({ capacity: 3, leak: 3, interval: '1s' });

  it('should drain and re-accept after time', async () => {
    const store = createKVStore(makeKV());
    await store.consume('k', spec, 3, 0);
    const r = await store.consume('k', spec, 3, 1000);
    expect(r.allowed).toBe(true);
  });

  it('should peek without consuming on cost 0', async () => {
    const kv = makeKV();
    const store = createKVStore(kv);
    await store.consume('k', spec, 1, 0);
    const p1 = await store.peek('k', spec, 0);
    expect(p1.remaining).toBe(2);
    const p2 = await store.peek('k', spec, 0);
    expect(p2.remaining).toBe(2);
  });

  it('should block when adding beyond capacity', async () => {
    const store = createKVStore(makeKV());
    await store.consume('k', spec, 3, 0);
    const blocked = await store.consume('k', spec, 1, 100);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfter).toBeGreaterThan(0);
  });
});

describe('createKVStore — token-bucket extra', () => {
  const spec = tokenBucket({ capacity: 3, refill: 3, interval: '1s' });

  it('should block and report retryAfter when bucket empty', async () => {
    const store = createKVStore(makeKV());
    await store.consume('k', spec, 3, 0);
    const blocked = await store.consume('k', spec, 1, 100);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfter).toBeGreaterThan(0);
  });
});

describe('createKVStore — sliding-window-counter peek branches', () => {
  const spec = slidingWindow({ limit: 3, window: '1m' });

  it('should peek when no entry exists yet', async () => {
    const store = createKVStore(makeKV());
    const p = await store.peek('k', spec, 0);
    expect(p.remaining).toBe(3);
  });

  it('should peek a blocked state and report retryAfter', async () => {
    const store = createKVStore(makeKV());
    await store.consume('k', spec, 3, 0);
    const p = await store.peek('k', spec, 100);
    expect(p.remaining).toBe(0);
    expect(p.retryAfter).toBeGreaterThan(0);
  });
});

describe('createKVStore — sliding-window-log peek branches', () => {
  const spec = slidingWindowLog({ limit: 2, window: '1m' });

  it('should peek when no entry exists yet', async () => {
    const store = createKVStore(makeKV());
    const p = await store.peek('k', spec, 0);
    expect(p.remaining).toBe(2);
  });

  it('should peek a blocked state and report retryAfter', async () => {
    const store = createKVStore(makeKV());
    await store.consume('k', spec, 2, 0);
    const p = await store.peek('k', spec, 100);
    expect(p.remaining).toBe(0);
    expect(p.retryAfter).toBeGreaterThan(0);
  });
});

describe('createKVStore — fixed-window peek branches', () => {
  const spec = fixedWindow({ limit: 2, window: '1m' });

  it('should peek a blocked state and report retryAfter', async () => {
    const store = createKVStore(makeKV());
    await store.consume('k', spec, 2, 0);
    const p = await store.peek('k', spec, 100);
    expect(p.remaining).toBe(0);
    expect(p.retryAfter).toBeGreaterThan(0);
  });
});

describe('createKVStore — reset / put / errors', () => {
  it('should delete a key on reset', async () => {
    const kv = makeKV();
    const store = createKVStore(kv);
    const spec = fixedWindow({ limit: 1, window: '1m' });
    await store.consume('k', spec, 1, 0);
    expect(kv.__store.size).toBe(1);
    expect(await store.reset('k')).toBe(true);
    expect(kv.__store.size).toBe(0);
  });

  it('should wrap delete errors as STORE_UNAVAILABLE', async () => {
    const kv: KVLike = {
      async get() {
        return null;
      },
      async put() {
        return undefined;
      },
      async delete() {
        throw new Error('network');
      },
    };
    const store = createKVStore(kv);
    await expect(store.reset('k')).rejects.toThrow(RateLimitError);
  });

  it('should wrap get errors as STORE_UNAVAILABLE', async () => {
    const kv: KVLike = {
      async get() {
        throw new Error('boom');
      },
      async put() {
        return undefined;
      },
      async delete() {
        return undefined;
      },
    };
    const store = createKVStore(kv);
    const spec = fixedWindow({ limit: 1, window: '1m' });
    await expect(store.consume('k', spec, 1, 0)).rejects.toThrow(RateLimitError);
    await expect(store.peek('k', spec, 0)).rejects.toThrow(RateLimitError);
  });

  it('should retry on put failure and surface STORE_UNAVAILABLE after exhausting', async () => {
    let calls = 0;
    const kv: KVLike = {
      async get() {
        return null;
      },
      async put() {
        calls++;
        throw new Error('flaky');
      },
      async delete() {
        return undefined;
      },
    };
    const store = createKVStore(kv, { retries: 2 });
    const spec = fixedWindow({ limit: 1, window: '1m' });
    await expect(store.consume('k', spec, 1, 0)).rejects.toThrow(RateLimitError);
    expect(calls).toBe(3);
  });

  it('should succeed when put recovers within retry budget', async () => {
    let calls = 0;
    const data = new Map<string, string>();
    const kv: KVLike = {
      async get(key) {
        const v = data.get(key);
        return v === undefined ? null : (JSON.parse(v) as unknown);
      },
      async put(key, value) {
        calls++;
        if (calls < 2) throw new Error('flaky');
        data.set(key, value);
      },
      async delete(key) {
        data.delete(key);
      },
    };
    const store = createKVStore(kv, { retries: 3 });
    const spec = fixedWindow({ limit: 1, window: '1m' });
    const r = await store.consume('k', spec, 1, 0);
    expect(r.allowed).toBe(true);
    expect(calls).toBe(2);
  });

  it('should not call put when blocked (cost > limit)', async () => {
    let puts = 0;
    const data = new Map<string, string>();
    const kv: KVLike = {
      async get(key) {
        const v = data.get(key);
        return v === undefined ? null : (JSON.parse(v) as unknown);
      },
      async put(key, value) {
        puts++;
        data.set(key, value);
      },
      async delete(key) {
        data.delete(key);
      },
    };
    const store = createKVStore(kv);
    const spec = fixedWindow({ limit: 1, window: '1m' });
    await store.consume('k', spec, 1, 0);
    expect(puts).toBe(1);
    const blocked = await store.consume('k', spec, 1, 100);
    expect(blocked.allowed).toBe(false);
    expect(puts).toBe(1);
  });
});

describe('createKVStore — option handling and validation', () => {
  it('should apply keyPrefix to stored keys', async () => {
    const kv = makeKV();
    const store = createKVStore(kv, { keyPrefix: 'tenant:1:' });
    const spec = fixedWindow({ limit: 1, window: '1m' });
    await store.consume('k', spec, 1, 0);
    expect([...kv.__store.keys()][0]).toBe('tenant:1:k');
  });

  it('should reject windows beyond the KV ceiling with WINDOW_TOO_LARGE', async () => {
    const store = createKVStore(makeKV());
    const tooBig = fixedWindow({ limit: 1, window: { days: 200 } });
    await expect(store.consume('k', tooBig, 1, 0)).rejects.toThrow(RateLimitError);
    await expect(store.peek('k', tooBig, 0)).rejects.toThrow(RateLimitError);
  });

  it('should throw INVALID_CONFIG on unknown spec.kind', async () => {
    const store = createKVStore(makeKV());
    const bogus = brand({ kind: 'bogus' as never }) as unknown as AlgorithmSpec;
    await expect(store.consume('k', bogus, 1, 0)).rejects.toThrow();
  });
});
