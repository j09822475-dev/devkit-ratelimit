import { describe, expect, it, vi } from 'vitest';
import {
  createUpstashStore,
  type UpstashLike,
} from '../adapters/upstash/index.js';
import { fixedWindow } from '../algorithms/fixed-window/index.js';
import { tokenBucket } from '../algorithms/token-bucket/index.js';
import { leakyBucket } from '../algorithms/leaky-bucket/index.js';
import { RateLimitError } from '../errors/base.js';

const okClient = (): UpstashLike => ({
  async eval() {
    return [1, 9, 60_000, 0];
  },
  async evalsha() {
    return [1, 9, 60_000, 0];
  },
  async scriptLoad() {
    return 'sha1';
  },
});

describe('createUpstashStore — basic dispatch', () => {
  it('should expose name "upstash"', () => {
    const store = createUpstashStore(okClient());
    expect(store.name).toBe('upstash');
  });

  it('should evalsha after script load on first consume', async () => {
    const evalsha = vi.fn().mockResolvedValue([1, 9, 60_000, 0]);
    const client: UpstashLike = {
      eval: vi.fn().mockResolvedValue([1, 9, 60_000, 0]),
      evalsha,
      scriptLoad: vi.fn().mockResolvedValue('sha1'),
    };
    const store = createUpstashStore(client);
    const r = await store.consume('k', fixedWindow({ limit: 10, window: '1m' }), 1, 0);
    expect(r.allowed).toBe(true);
    expect(evalsha).toHaveBeenCalled();
  });

  it('should fall back to eval when scriptLoad throws', async () => {
    const ev = vi.fn().mockResolvedValue([1, 9, 60_000, 0]);
    const client: UpstashLike = {
      eval: ev,
      evalsha: vi.fn(),
      scriptLoad: vi.fn().mockRejectedValue(new Error('not allowed')),
    };
    const store = createUpstashStore(client);
    await store.consume('k', fixedWindow({ limit: 10, window: '1m' }), 1, 0);
    expect(ev).toHaveBeenCalled();
  });

  it('should fall back to eval after NOSCRIPT and re-cache', async () => {
    let calls = 0;
    const client: UpstashLike = {
      async eval() {
        return [1, 9, 60_000, 0];
      },
      async evalsha() {
        calls++;
        if (calls === 1) throw new Error('NOSCRIPT');
        return [1, 9, 60_000, 0];
      },
      async scriptLoad() {
        return 'sha1';
      },
    };
    const store = createUpstashStore(client);
    await store.consume('k', fixedWindow({ limit: 10, window: '1m' }), 1, 0);
    await store.consume('k', fixedWindow({ limit: 10, window: '1m' }), 1, 0);
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it('should rethrow non-NOSCRIPT errors from evalsha', async () => {
    const client: UpstashLike = {
      async eval() {
        return [1, 9, 60_000, 0];
      },
      async evalsha() {
        throw new Error('READONLY');
      },
      async scriptLoad() {
        return 'sha1';
      },
    };
    const store = createUpstashStore(client);
    await expect(
      store.consume('k', fixedWindow({ limit: 10, window: '1m' }), 1, 0),
    ).rejects.toThrow(/READONLY/);
  });

  it('should use plain eval when neither scriptLoad nor evalsha provided', async () => {
    const ev = vi.fn().mockResolvedValue([1, 9, 60_000, 0]);
    const client: UpstashLike = { eval: ev };
    const store = createUpstashStore(client);
    await store.consume('k', fixedWindow({ limit: 10, window: '1m' }), 1, 0);
    expect(ev).toHaveBeenCalled();
  });
});

describe('createUpstashStore — peek and reset', () => {
  it('should peek by passing cost=0', async () => {
    const store = createUpstashStore(okClient());
    const p = await store.peek('k', fixedWindow({ limit: 10, window: '1m' }), 0);
    expect(p.remaining).toBe(9);
  });

  it('should reset by EVAL DEL', async () => {
    const ev = vi.fn().mockResolvedValue(1);
    const store = createUpstashStore({ eval: ev });
    expect(await store.reset('k')).toBe(true);
    expect(ev.mock.calls[0]![0]).toContain('DEL');
  });

  it('should return false on reset when DEL reports 0', async () => {
    const store = createUpstashStore({
      async eval() {
        return 0;
      },
    });
    expect(await store.reset('k')).toBe(false);
  });

  it('should wrap reset error as STORE_UNAVAILABLE', async () => {
    const store = createUpstashStore({
      async eval() {
        throw new Error('network');
      },
    });
    await expect(store.reset('k')).rejects.toThrow(RateLimitError);
  });
});

describe('createUpstashStore — error mapping', () => {
  it('should reject malformed reply', async () => {
    const store = createUpstashStore({
      async eval() {
        return null;
      },
    });
    await expect(
      store.consume('k', fixedWindow({ limit: 10, window: '1m' }), 1, 0),
    ).rejects.toThrow(RateLimitError);
  });

  it('should reject too-short reply', async () => {
    const store = createUpstashStore({
      async eval() {
        return [1];
      },
    });
    await expect(
      store.consume('k', fixedWindow({ limit: 10, window: '1m' }), 1, 0),
    ).rejects.toThrow(RateLimitError);
  });

  it('should coerce string-typed reply numbers', async () => {
    const store = createUpstashStore({
      async eval() {
        return ['1', '9', '60000', '0'];
      },
    });
    const r = await store.consume('k', fixedWindow({ limit: 10, window: '1m' }), 1, 0);
    expect(r.remaining).toBe(9);
  });
});

describe('createUpstashStore — keyPrefix and bucket-style args', () => {
  it('should apply keyPrefix to outbound keys', async () => {
    let seenKey: string | undefined;
    const client: UpstashLike = {
      async eval(_script, keys) {
        seenKey = keys[0];
        return [1, 9, 60_000, 0];
      },
    };
    const store = createUpstashStore(client, { keyPrefix: 't:' });
    await store.consume('k', fixedWindow({ limit: 10, window: '1m' }), 1, 0);
    expect(seenKey).toBe('t:k');
  });

  it('should pass leaky-bucket args correctly', async () => {
    let seenArgs: (string | number)[] | undefined;
    const client: UpstashLike = {
      async eval(_script, _keys, args) {
        seenArgs = args;
        return [1, 9, 0, 0];
      },
    };
    const store = createUpstashStore(client);
    const spec = leakyBucket({ capacity: 10, leak: 2, interval: '1s' });
    await store.consume('k', spec, 1, 100);
    expect(seenArgs).toEqual([100, 1, 10, 2, 1000]);
  });

  it('should pass token-bucket args correctly', async () => {
    let seenArgs: (string | number)[] | undefined;
    const client: UpstashLike = {
      async eval(_script, _keys, args) {
        seenArgs = args;
        return [1, 9, 0, 0];
      },
    };
    const store = createUpstashStore(client);
    const spec = tokenBucket({ capacity: 10, refill: 5, interval: '1s' });
    await store.consume('k', spec, 1, 100);
    expect(seenArgs).toEqual([100, 1, 10, 5, 1000]);
  });
});
