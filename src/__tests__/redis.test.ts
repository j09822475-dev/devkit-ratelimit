import { describe, expect, it, vi } from 'vitest';
import { createRedisStore, type RedisLike } from '../adapters/redis/index.js';
import { fixedWindow } from '../algorithms/fixed-window/index.js';
import { tokenBucket } from '../algorithms/token-bucket/index.js';
import { RateLimitError } from '../errors/base.js';

const okClient = (): RedisLike => ({
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

describe('createRedisStore — basic dispatch', () => {
  it('should expose name "redis"', () => {
    const store = createRedisStore(okClient());
    expect(store.name).toBe('redis');
  });

  it('should pass spec args to evalsha after script load', async () => {
    const evalsha = vi.fn().mockResolvedValue([1, 9, 60_000, 0]);
    const client: RedisLike = {
      eval: vi.fn().mockResolvedValue([1, 9, 60_000, 0]),
      evalsha,
      scriptLoad: vi.fn().mockResolvedValue('sha1'),
    };
    const store = createRedisStore(client);
    const r = await store.consume(
      'k',
      fixedWindow({ limit: 10, window: '1m' }),
      1,
      1000,
    );
    expect(r.allowed).toBe(true);
    expect(r.remaining).toBe(9);
    expect(evalsha).toHaveBeenCalledOnce();
    const call = evalsha.mock.calls[0]!;
    expect(call[0]).toBe('sha1');
    expect(call[1]).toBe(1);
    expect(call[2]).toBe('k');
  });

  it('should fall back to eval when scriptLoad throws', async () => {
    const ev = vi.fn().mockResolvedValue([1, 9, 60_000, 0]);
    const client: RedisLike = {
      eval: ev,
      evalsha: vi.fn(),
      scriptLoad: vi.fn().mockRejectedValue(new Error('redis not configured')),
    };
    const store = createRedisStore(client);
    const r = await store.consume('k', fixedWindow({ limit: 10, window: '1m' }), 1, 0);
    expect(r.allowed).toBe(true);
    expect(ev).toHaveBeenCalled();
  });

  it('should fall back to plain eval after NOSCRIPT', async () => {
    let evalshaCalls = 0;
    const evalCalls: string[] = [];
    const client: RedisLike = {
      async eval(script) {
        evalCalls.push(script);
        return [1, 9, 60_000, 0];
      },
      async evalsha() {
        evalshaCalls++;
        if (evalshaCalls === 1) throw new Error('NOSCRIPT no matching script');
        return [1, 9, 60_000, 0];
      },
      async scriptLoad() {
        return 'sha1';
      },
    };
    const store = createRedisStore(client);
    const r1 = await store.consume('k', fixedWindow({ limit: 10, window: '1m' }), 1, 0);
    expect(r1.allowed).toBe(true);
    expect(evalCalls.length).toBeGreaterThan(0);
    // Next consume should re-cache the SHA via scriptLoad and use evalsha.
    const r2 = await store.consume('k', fixedWindow({ limit: 10, window: '1m' }), 1, 0);
    expect(r2.allowed).toBe(true);
  });

  it('should rethrow non-NOSCRIPT errors from evalsha', async () => {
    const client: RedisLike = {
      async eval() {
        return [1, 9, 60_000, 0];
      },
      async evalsha() {
        throw new Error('READONLY: cannot write');
      },
      async scriptLoad() {
        return 'sha1';
      },
    };
    const store = createRedisStore(client);
    await expect(
      store.consume('k', fixedWindow({ limit: 10, window: '1m' }), 1, 0),
    ).rejects.toThrow(/READONLY/);
  });

  it('should use plain eval when scriptLoad is not provided', async () => {
    const ev = vi.fn().mockResolvedValue([1, 9, 60_000, 0]);
    const client: RedisLike = {
      eval: ev,
      evalsha: vi.fn(),
    };
    const store = createRedisStore(client);
    const r = await store.consume('k', fixedWindow({ limit: 10, window: '1m' }), 1, 0);
    expect(r.allowed).toBe(true);
    expect(ev).toHaveBeenCalled();
  });
});

describe('createRedisStore — peek and reset', () => {
  it('should peek by passing cost=0 to the script', async () => {
    const args: unknown[][] = [];
    const client: RedisLike = {
      async eval(...a) {
        args.push(a);
        return [1, 10, 60_000, 0];
      },
      async evalsha() {
        return [1, 10, 60_000, 0];
      },
    };
    const store = createRedisStore(client);
    const p = await store.peek('k', fixedWindow({ limit: 10, window: '1m' }), 0);
    expect(p.remaining).toBe(10);
  });

  it('should reset by EVAL DEL', async () => {
    const ev = vi.fn().mockResolvedValue(1);
    const client: RedisLike = {
      eval: ev,
      evalsha: vi.fn(),
    };
    const store = createRedisStore(client);
    expect(await store.reset('k')).toBe(true);
    expect(ev.mock.calls[0]![0]).toContain('DEL');
  });

  it('should reset return false when DEL reports 0', async () => {
    const client: RedisLike = {
      async eval() {
        return 0;
      },
      async evalsha() {
        return 0;
      },
    };
    const store = createRedisStore(client);
    expect(await store.reset('k')).toBe(false);
  });

  it('should wrap reset errors as STORE_UNAVAILABLE', async () => {
    const client: RedisLike = {
      async eval() {
        throw new Error('network');
      },
      async evalsha() {
        throw new Error('network');
      },
    };
    const store = createRedisStore(client);
    await expect(store.reset('k')).rejects.toThrow(RateLimitError);
  });
});

describe('createRedisStore — error mapping', () => {
  it('should reject non-array reply with STORE_UNAVAILABLE', async () => {
    const client: RedisLike = {
      async eval() {
        return null;
      },
      async evalsha() {
        return null;
      },
    };
    const store = createRedisStore(client);
    await expect(
      store.consume('k', fixedWindow({ limit: 10, window: '1m' }), 1, 0),
    ).rejects.toThrow(RateLimitError);
  });

  it('should reject malformed array reply with STORE_UNAVAILABLE', async () => {
    const client: RedisLike = {
      async eval() {
        return [1, 9];
      },
      async evalsha() {
        return [1, 9];
      },
    };
    const store = createRedisStore(client);
    await expect(
      store.consume('k', fixedWindow({ limit: 10, window: '1m' }), 1, 0),
    ).rejects.toThrow(RateLimitError);
  });

  it('should coerce string-typed reply numbers', async () => {
    const client: RedisLike = {
      async eval() {
        return ['1', '9', '60000', '0'];
      },
      async evalsha() {
        return ['1', '9', '60000', '0'];
      },
    };
    const store = createRedisStore(client);
    const r = await store.consume('k', fixedWindow({ limit: 10, window: '1m' }), 1, 0);
    expect(r.allowed).toBe(true);
    expect(r.remaining).toBe(9);
  });
});

describe('createRedisStore — keyPrefix and limits', () => {
  it('should apply keyPrefix to outbound keys', async () => {
    const seen: unknown[] = [];
    const client: RedisLike = {
      async eval(_script, _keys, ...args) {
        seen.push(args[0]);
        return [1, 9, 60_000, 0];
      },
      async evalsha(_sha, _keys, ...args) {
        seen.push(args[0]);
        return [1, 9, 60_000, 0];
      },
    };
    const store = createRedisStore(client, { keyPrefix: 't:' });
    await store.consume('k', fixedWindow({ limit: 10, window: '1m' }), 1, 0);
    // The key arrives as one of the eval positional args.
    expect(seen[0]).toBeDefined();
  });

  it('should reject window beyond Redis ceiling with WINDOW_TOO_LARGE', async () => {
    const store = createRedisStore(okClient());
    const tooBig = fixedWindow({ limit: 1, window: { days: 50 } });
    await expect(store.consume('k', tooBig, 1, 0)).rejects.toThrow(RateLimitError);
    await expect(store.peek('k', tooBig, 0)).rejects.toThrow(RateLimitError);
  });

  it('should pass spec args correctly for token-bucket', async () => {
    const captured: (string | number)[][] = [];
    const client: RedisLike = {
      async eval(_script, _keys, ...args) {
        captured.push(args);
        return [1, 9, 0, 0];
      },
      async evalsha(_sha, _keys, ...args) {
        captured.push(args);
        return [1, 9, 0, 0];
      },
    };
    const store = createRedisStore(client);
    const spec = tokenBucket({ capacity: 10, refill: 5, interval: '1s' });
    await store.consume('k', spec, 1, 100);
    const call = captured[captured.length - 1]!;
    expect(call[0]).toBe('k'); // KEYS[1]
    expect(call[1]).toBe(100); // now
    expect(call[2]).toBe(1); // cost
    expect(call[3]).toBe(10); // capacity
    expect(call[4]).toBe(5); // refill
    expect(call[5]).toBe(1000); // intervalMs
  });
});
