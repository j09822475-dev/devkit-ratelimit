import { describe, expect, it } from 'vitest';
import {
  createDurableObjectStore,
  type DurableObjectIdLike,
  type DurableObjectNamespaceLike,
  type DurableObjectStubLike,
} from '../adapters/durable-object/index.js';
import {
  RateLimitDurableObject,
  type DurableObjectStateLike,
} from '../adapters/durable-object/ratelimit-do.js';
import { fixedWindow } from '../algorithms/fixed-window/index.js';
import { tokenBucket } from '../algorithms/token-bucket/index.js';
import { leakyBucket } from '../algorithms/leaky-bucket/index.js';
import { slidingWindow } from '../algorithms/sliding-window/index.js';
import { slidingWindowLog } from '../algorithms/sliding-window-log/index.js';
import { RateLimitError } from '../errors/base.js';
import type { AlgorithmSpec } from '../types/algorithm.js';

const makeState = (): DurableObjectStateLike => {
  const data = new Map<string, unknown>();
  return {
    storage: {
      async get(key) {
        return data.get(key) as never;
      },
      async put(key, value) {
        data.set(key, value);
      },
      async delete(key) {
        return data.delete(key);
      },
    },
  };
};

const makeNamespace = (): DurableObjectNamespaceLike => {
  // Each id maps to one DO instance — to mimic the runtime's actor-per-id model.
  const dos = new Map<string, RateLimitDurableObject>();
  return {
    idFromName(name: string): DurableObjectIdLike {
      return { __brand: 'do-id', __name: name } as unknown as DurableObjectIdLike;
    },
    get(id: DurableObjectIdLike): DurableObjectStubLike {
      const name = (id as unknown as { __name: string }).__name;
      let inst = dos.get(name);
      if (inst === undefined) {
        inst = new RateLimitDurableObject(makeState());
        dos.set(name, inst);
      }
      const stub: DurableObjectStubLike = {
        async fetch(input) {
          const req = input instanceof Request ? input : new Request(input);
          return inst.fetch(req);
        },
      };
      return stub;
    },
  };
};

describe('createDurableObjectStore — fixed-window via DO', () => {
  const spec = fixedWindow({ limit: 3, window: '1m' });

  it('should allow up to limit and block above', async () => {
    const store = createDurableObjectStore(makeNamespace());
    expect((await store.consume('k', spec, 1, 0)).allowed).toBe(true);
    expect((await store.consume('k', spec, 2, 100)).allowed).toBe(true);
    expect((await store.consume('k', spec, 1, 200)).allowed).toBe(false);
  });

  it('should peek without consuming', async () => {
    const store = createDurableObjectStore(makeNamespace());
    await store.consume('k', spec, 1, 0);
    const p = await store.peek('k', spec, 100);
    expect(p.remaining).toBe(2);
    const p2 = await store.peek('k', spec, 200);
    expect(p2.remaining).toBe(2);
  });

  it('should reset a key and report whether it existed', async () => {
    const store = createDurableObjectStore(makeNamespace());
    await store.consume('k', spec, 1, 0);
    expect(await store.reset('k')).toBe(true);
    expect(await store.reset('never-seen')).toBe(false);
  });
});

describe('createDurableObjectStore — every algorithm', () => {
  it('should run sliding-window-counter through DO', async () => {
    const store = createDurableObjectStore(makeNamespace());
    const spec = slidingWindow({ limit: 4, window: '1m' });
    await store.consume('k', spec, 4, 0);
    expect((await store.consume('k', spec, 1, 60_000)).allowed).toBe(false);
  });

  it('should run sliding-window-log through DO', async () => {
    const store = createDurableObjectStore(makeNamespace());
    const spec = slidingWindowLog({ limit: 2, window: '1m' });
    await store.consume('k', spec, 2, 0);
    expect((await store.consume('k', spec, 1, 100)).allowed).toBe(false);
    expect((await store.consume('k', spec, 1, 60_001)).allowed).toBe(true);
  });

  it('should run token-bucket through DO', async () => {
    const store = createDurableObjectStore(makeNamespace());
    const spec = tokenBucket({ capacity: 3, refill: 3, interval: '1s' });
    await store.consume('k', spec, 3, 0);
    expect((await store.consume('k', spec, 1, 100)).allowed).toBe(false);
    expect((await store.consume('k', spec, 3, 1000)).allowed).toBe(true);
  });

  it('should run leaky-bucket through DO', async () => {
    const store = createDurableObjectStore(makeNamespace());
    const spec = leakyBucket({ capacity: 3, leak: 3, interval: '1s' });
    await store.consume('k', spec, 3, 0);
    expect((await store.consume('k', spec, 1, 100)).allowed).toBe(false);
    expect((await store.consume('k', spec, 3, 1000)).allowed).toBe(true);
  });
});

describe('createDurableObjectStore — error wrapping', () => {
  it('should wrap fetch failures as STORE_UNAVAILABLE', async () => {
    const namespace: DurableObjectNamespaceLike = {
      idFromName() {
        return { __brand: 'do-id' };
      },
      get() {
        return {
          async fetch() {
            throw new Error('network');
          },
        };
      },
    };
    const store = createDurableObjectStore(namespace);
    await expect(
      store.consume('k', fixedWindow({ limit: 1, window: '1m' }), 1, 0),
    ).rejects.toThrow(RateLimitError);
  });

  it('should surface non-2xx fetch responses as STORE_UNAVAILABLE', async () => {
    const namespace: DurableObjectNamespaceLike = {
      idFromName() {
        return { __brand: 'do-id' };
      },
      get() {
        return {
          async fetch() {
            return new Response('nope', { status: 500 });
          },
        };
      },
    };
    const store = createDurableObjectStore(namespace);
    await expect(
      store.consume('k', fixedWindow({ limit: 1, window: '1m' }), 1, 0),
    ).rejects.toThrow(RateLimitError);
  });
});

describe('createDurableObjectStore — keyPrefix and idFromName', () => {
  it('should pass keyPrefix to idFromName', async () => {
    const seen: string[] = [];
    const inner = new RateLimitDurableObject(makeState());
    const namespace: DurableObjectNamespaceLike = {
      idFromName(name: string) {
        seen.push(name);
        return { __brand: 'do-id' };
      },
      get() {
        return {
          fetch(input) {
            const req = input instanceof Request ? input : new Request(input);
            return inner.fetch(req);
          },
        };
      },
    };
    const store = createDurableObjectStore(namespace, { keyPrefix: 't:' });
    await store.consume('k', fixedWindow({ limit: 1, window: '1m' }), 1, 0);
    expect(seen[0]).toBe('t:k');
  });
});

describe('RateLimitDurableObject.fetch — direct invocation', () => {
  const json = (body: unknown) =>
    new Request('https://do/rpc', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('should reject malformed JSON with 400', async () => {
    const inst = new RateLimitDurableObject(makeState());
    const res = await inst.fetch(
      new Request('https://do/rpc', { method: 'POST', body: 'not json' }),
    );
    expect(res.status).toBe(400);
  });

  it('should reject missing op/key with 400', async () => {
    const inst = new RateLimitDurableObject(makeState());
    const res = await inst.fetch(json({}));
    expect(res.status).toBe(400);
  });

  it('should reject empty key with 400', async () => {
    const inst = new RateLimitDurableObject(makeState());
    const res = await inst.fetch(json({ op: 'consume', key: '' }));
    expect(res.status).toBe(400);
  });

  it('should reject missing spec/now on consume with 400', async () => {
    const inst = new RateLimitDurableObject(makeState());
    const res = await inst.fetch(json({ op: 'consume', key: 'k' }));
    expect(res.status).toBe(400);
  });

  it('should reject invalid spec (negative capacity) with 400', async () => {
    const inst = new RateLimitDurableObject(makeState());
    const res = await inst.fetch(
      json({
        op: 'consume',
        key: 'k',
        spec: { kind: 'token-bucket', capacity: -1, refill: 1, intervalMs: 1000 },
        now: 0,
      }),
    );
    expect(res.status).toBe(400);
  });

  it('should reject invalid spec (window-style with bad limit) with 400', async () => {
    const inst = new RateLimitDurableObject(makeState());
    const res = await inst.fetch(
      json({
        op: 'consume',
        key: 'k',
        spec: { kind: 'fixed-window', limit: 0, windowMs: 1000 },
        now: 0,
      }),
    );
    expect(res.status).toBe(400);
  });

  it('should reject invalid spec (leaky-bucket with bad leak) with 400', async () => {
    const inst = new RateLimitDurableObject(makeState());
    const res = await inst.fetch(
      json({
        op: 'consume',
        key: 'k',
        spec: { kind: 'leaky-bucket', capacity: 1, leak: -1, intervalMs: 1000 },
        now: 0,
      }),
    );
    expect(res.status).toBe(400);
  });

  it('should reject unknown algorithm kind with 400', async () => {
    const inst = new RateLimitDurableObject(makeState());
    const res = await inst.fetch(
      json({
        op: 'consume',
        key: 'k',
        spec: { kind: 'mystery' } as unknown as AlgorithmSpec,
        now: 0,
      }),
    );
    expect(res.status).toBe(400);
  });

  it('should reject NaN now with 400', async () => {
    const inst = new RateLimitDurableObject(makeState());
    const res = await inst.fetch(
      json({
        op: 'consume',
        key: 'k',
        spec: { kind: 'fixed-window', limit: 1, windowMs: 1000 },
        now: 'bad',
      }),
    );
    expect(res.status).toBe(400);
  });

  it('should reject negative cost with 400', async () => {
    const inst = new RateLimitDurableObject(makeState());
    const res = await inst.fetch(
      json({
        op: 'consume',
        key: 'k',
        spec: { kind: 'fixed-window', limit: 1, windowMs: 1000 },
        now: 0,
        cost: -1,
      }),
    );
    expect(res.status).toBe(400);
  });

  it('should accept a default cost when not supplied', async () => {
    const inst = new RateLimitDurableObject(makeState());
    const res = await inst.fetch(
      json({
        op: 'consume',
        key: 'k',
        spec: { kind: 'fixed-window', limit: 1, windowMs: 1000 },
        now: 0,
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { allowed: boolean; remaining: number };
    expect(body.allowed).toBe(true);
    expect(body.remaining).toBe(0);
  });

  it('should serve peek without persisting', async () => {
    const inst = new RateLimitDurableObject(makeState());
    const res = await inst.fetch(
      json({
        op: 'peek',
        key: 'k',
        spec: { kind: 'fixed-window', limit: 5, windowMs: 1000 },
        now: 0,
      }),
    );
    const body = (await res.json()) as { remaining: number };
    expect(body.remaining).toBe(5);
  });

  it('should serve reset and report existed:false on a fresh DO', async () => {
    const inst = new RateLimitDurableObject(makeState());
    const res = await inst.fetch(json({ op: 'reset', key: 'k' }));
    const body = (await res.json()) as { existed: boolean };
    expect(body.existed).toBe(false);
  });

  it('should reject unknown op with 400', async () => {
    const inst = new RateLimitDurableObject(makeState());
    const res = await inst.fetch(
      json({
        op: 'mystery',
        key: 'k',
        spec: { kind: 'fixed-window', limit: 1, windowMs: 1000 },
        now: 0,
      }),
    );
    expect(res.status).toBe(400);
  });

  it('should run blockConcurrencyWhile when state exposes it', async () => {
    let calls = 0;
    const state: DurableObjectStateLike = makeState();
    state.blockConcurrencyWhile = async <T>(fn: () => Promise<T>) => {
      calls++;
      return fn();
    };
    const inst = new RateLimitDurableObject(state);
    await inst.fetch(
      json({
        op: 'consume',
        key: 'k',
        spec: { kind: 'fixed-window', limit: 1, windowMs: 1000 },
        now: 0,
      }),
    );
    expect(calls).toBeGreaterThan(0);
  });
});
