import { describe, expect, it } from 'vitest';
import {
  createD1Store,
  type D1Like,
  type D1PreparedStatementLike,
} from '../adapters/cloudflare-d1/index.js';
import { fixedWindow } from '../algorithms/fixed-window/index.js';
import { slidingWindowLog } from '../algorithms/sliding-window-log/index.js';
import { tokenBucket } from '../algorithms/token-bucket/index.js';
import { leakyBucket } from '../algorithms/leaky-bucket/index.js';
import { slidingWindow } from '../algorithms/sliding-window/index.js';
import { RateLimitError } from '../errors/base.js';

interface FakeRow {
  key: string;
  kind: string;
  data: string;
  updated_at: number;
}

const makeD1 = (): D1Like & { __rows: Map<string, FakeRow> } => {
  const rows = new Map<string, FakeRow>();
  return {
    __rows: rows,
    prepare(query: string): D1PreparedStatementLike {
      let bound: (string | number | null)[] = [];
      const stmt: D1PreparedStatementLike = {
        bind(...values) {
          bound = values;
          return stmt;
        },
        async first<T = unknown>(): Promise<T | null> {
          if (query.startsWith('SELECT')) {
            const key = String(bound[0]);
            return (rows.get(key) ?? null) as unknown as T | null;
          }
          return null;
        },
        async run() {
          if (query.startsWith('INSERT')) {
            const [key, kind, data, updated_at, oldUpdatedAt, oldData] = bound as [
              string,
              string,
              string,
              number,
              number,
              string,
            ];
            const existing = rows.get(key);
            if (existing === undefined) {
              rows.set(key, { key, kind, data, updated_at });
              return { success: true, meta: { changes: 1 } };
            }
            if (existing.updated_at === oldUpdatedAt && existing.data === oldData) {
              rows.set(key, { key, kind, data, updated_at });
              return { success: true, meta: { changes: 1 } };
            }
            return { success: true, meta: { changes: 0 } };
          }
          if (query.startsWith('DELETE FROM') && query.includes('WHERE updated_at')) {
            const cutoff = bound[0] as number;
            let n = 0;
            for (const [key, row] of rows) {
              if (row.updated_at < cutoff) {
                rows.delete(key);
                n++;
              }
            }
            return { success: true, meta: { changes: n } };
          }
          if (query.startsWith('DELETE FROM')) {
            const key = String(bound[0]);
            const had = rows.delete(key);
            return { success: true, meta: { changes: had ? 1 : 0 } };
          }
          return { success: false };
        },
      };
      return stmt;
    },
  };
};

describe('createD1Store — fixed-window', () => {
  const spec = fixedWindow({ limit: 3, window: '1m' });

  it('should allow up to limit and block above', async () => {
    const store = createD1Store(makeD1());
    expect((await store.consume('k', spec, 1, 0)).allowed).toBe(true);
    expect((await store.consume('k', spec, 2, 100)).allowed).toBe(true);
    expect((await store.consume('k', spec, 1, 200)).allowed).toBe(false);
  });

  it('should reset at window boundary', async () => {
    const store = createD1Store(makeD1());
    await store.consume('k', spec, 3, 0);
    expect((await store.consume('k', spec, 1, 60_000)).allowed).toBe(true);
  });

  it('should peek without writing', async () => {
    const d1 = makeD1();
    const store = createD1Store(d1);
    const p = await store.peek('k', spec, 0);
    expect(p.remaining).toBe(3);
    expect(d1.__rows.size).toBe(0);
  });
});

describe('createD1Store — algorithms', () => {
  it('should drive sliding-window-counter', async () => {
    const store = createD1Store(makeD1());
    const spec = slidingWindow({ limit: 4, window: '1m' });
    await store.consume('k', spec, 4, 0);
    const r = await store.consume('k', spec, 1, 60_000);
    expect(r.allowed).toBe(false);
  });

  it('should drive sliding-window-log', async () => {
    const store = createD1Store(makeD1());
    const spec = slidingWindowLog({ limit: 2, window: '1m' });
    await store.consume('k', spec, 1, 0);
    await store.consume('k', spec, 1, 100);
    expect((await store.consume('k', spec, 1, 200)).allowed).toBe(false);
    expect((await store.consume('k', spec, 1, 60_001)).allowed).toBe(true);
  });

  it('should drive token-bucket', async () => {
    const store = createD1Store(makeD1());
    const spec = tokenBucket({ capacity: 3, refill: 3, interval: '1s' });
    await store.consume('k', spec, 3, 0);
    expect((await store.consume('k', spec, 1, 100)).allowed).toBe(false);
    expect((await store.consume('k', spec, 3, 1000)).allowed).toBe(true);
  });

  it('should drive leaky-bucket', async () => {
    const store = createD1Store(makeD1());
    const spec = leakyBucket({ capacity: 3, leak: 3, interval: '1s' });
    await store.consume('k', spec, 3, 0);
    expect((await store.consume('k', spec, 1, 100)).allowed).toBe(false);
    expect((await store.consume('k', spec, 3, 1000)).allowed).toBe(true);
  });
});

describe('createD1Store — peek paths', () => {
  it('should peek empty bucket without writing', async () => {
    const d1 = makeD1();
    const store = createD1Store(d1);
    const spec = tokenBucket({ capacity: 3, refill: 3, interval: '1s' });
    const p = await store.peek('k', spec, 0);
    expect(p.remaining).toBe(3);
    expect(d1.__rows.size).toBe(0);
  });

  it('should peek a leaky bucket', async () => {
    const store = createD1Store(makeD1());
    const spec = leakyBucket({ capacity: 3, leak: 3, interval: '1s' });
    await store.consume('k', spec, 1, 0);
    const p = await store.peek('k', spec, 0);
    expect(p.remaining).toBe(2);
  });

  it('should peek a sliding-window-log entry without writing', async () => {
    const d1 = makeD1();
    const store = createD1Store(d1);
    const spec = slidingWindowLog({ limit: 3, window: '1m' });
    await store.consume('k', spec, 1, 0);
    const p = await store.peek('k', spec, 0);
    expect(p.remaining).toBe(2);
  });

  it('should peek a sliding-window-counter entry without writing', async () => {
    const d1 = makeD1();
    const store = createD1Store(d1);
    const spec = slidingWindow({ limit: 3, window: '1m' });
    await store.consume('k', spec, 1, 0);
    const p = await store.peek('k', spec, 100);
    expect(p.remaining).toBe(2);
  });
});

describe('createD1Store — corrupted row tolerance', () => {
  it('should treat a row from a different algorithm as missing', async () => {
    const d1 = makeD1();
    d1.__rows.set('k', {
      key: 'k',
      kind: 'token-bucket',
      data: JSON.stringify({ level: 1, updatedAt: 0 }),
      updated_at: 0,
    });
    const store = createD1Store(d1);
    // Different algorithm; decode returns null and we start fresh.
    const spec = fixedWindow({ limit: 3, window: '1m' });
    const r = await store.consume('k', spec, 1, 0);
    expect(r.allowed).toBe(true);
    expect(r.remaining).toBe(2);
  });

  it('should treat a row with invalid JSON as missing', async () => {
    const d1 = makeD1();
    d1.__rows.set('k', {
      key: 'k',
      kind: 'fixed-window',
      data: 'not-json',
      updated_at: 0,
    });
    const store = createD1Store(d1);
    const spec = fixedWindow({ limit: 3, window: '1m' });
    const r = await store.consume('k', spec, 1, 0);
    expect(r.allowed).toBe(true);
  });
});

describe('createD1Store — reset / sweep / errors', () => {
  it('should delete a key on reset', async () => {
    const d1 = makeD1();
    const store = createD1Store(d1);
    const spec = fixedWindow({ limit: 1, window: '1m' });
    await store.consume('k', spec, 1, 0);
    expect(d1.__rows.size).toBe(1);
    expect(await store.reset('k')).toBe(true);
    expect(d1.__rows.size).toBe(0);
  });

  it('should sweep entries older than 7 days', async () => {
    const d1 = makeD1();
    const store = createD1Store(d1);
    const spec = fixedWindow({ limit: 1, window: '1m' });
    await store.consume('k', spec, 1, 0);
    const dropped = (await store.sweep?.(8 * 86_400_000)) ?? 0;
    expect(dropped).toBe(1);
  });

  it('should sweep return 0 when no rows are old enough', async () => {
    const d1 = makeD1();
    const store = createD1Store(d1);
    const spec = fixedWindow({ limit: 1, window: '1m' });
    await store.consume('k', spec, 1, Date.now());
    const dropped = (await store.sweep?.()) ?? 0;
    expect(dropped).toBe(0);
  });

  it('should sweep return 0 when DELETE throws', async () => {
    const d1: D1Like = {
      prepare(query: string) {
        const stmt: D1PreparedStatementLike = {
          bind() {
            return stmt;
          },
          async first() {
            return null;
          },
          async run() {
            if (query.startsWith('DELETE')) throw new Error('disk');
            return { success: true };
          },
        };
        return stmt;
      },
    };
    const store = createD1Store(d1);
    expect(await store.sweep?.()).toBe(0);
  });

  it('should wrap select errors as STORE_UNAVAILABLE on consume', async () => {
    const d1: D1Like = {
      prepare() {
        const stmt: D1PreparedStatementLike = {
          bind() {
            return stmt;
          },
          async first() {
            throw new Error('disk');
          },
          async run() {
            return { success: true };
          },
        };
        return stmt;
      },
    };
    const store = createD1Store(d1);
    await expect(
      store.consume('k', fixedWindow({ limit: 1, window: '1m' }), 1, 0),
    ).rejects.toThrow(RateLimitError);
  });

  it('should wrap upsert errors as STORE_UNAVAILABLE', async () => {
    const d1: D1Like = {
      prepare(query: string) {
        const stmt: D1PreparedStatementLike = {
          bind() {
            return stmt;
          },
          async first() {
            return null;
          },
          async run() {
            if (query.startsWith('INSERT')) throw new Error('write');
            return { success: true };
          },
        };
        return stmt;
      },
    };
    const store = createD1Store(d1);
    await expect(
      store.consume('k', fixedWindow({ limit: 1, window: '1m' }), 1, 0),
    ).rejects.toThrow(RateLimitError);
  });

  it('should wrap select errors as STORE_UNAVAILABLE on peek', async () => {
    const d1: D1Like = {
      prepare() {
        const stmt: D1PreparedStatementLike = {
          bind() {
            return stmt;
          },
          async first() {
            throw new Error('disk');
          },
          async run() {
            return { success: true };
          },
        };
        return stmt;
      },
    };
    const store = createD1Store(d1);
    await expect(
      store.peek('k', fixedWindow({ limit: 1, window: '1m' }), 0),
    ).rejects.toThrow(RateLimitError);
  });

  it('should wrap delete errors as STORE_UNAVAILABLE on reset', async () => {
    const d1: D1Like = {
      prepare() {
        const stmt: D1PreparedStatementLike = {
          bind() {
            return stmt;
          },
          async first() {
            return null;
          },
          async run() {
            throw new Error('disk');
          },
        };
        return stmt;
      },
    };
    const store = createD1Store(d1);
    await expect(store.reset('k')).rejects.toThrow(RateLimitError);
  });

  it('should retry CAS upsert on lost race and eventually succeed', async () => {
    const rows = new Map<string, FakeRow>();
    let calls = 0;
    const d1: D1Like = {
      prepare(query: string) {
        let bound: (string | number | null)[] = [];
        const stmt: D1PreparedStatementLike = {
          bind(...values) {
            bound = values;
            return stmt;
          },
          async first<T = unknown>(): Promise<T | null> {
            if (query.startsWith('SELECT')) {
              const key = String(bound[0]);
              return (rows.get(key) ?? null) as unknown as T | null;
            }
            return null;
          },
          async run() {
            if (query.startsWith('INSERT')) {
              calls++;
              if (calls === 1) {
                // Simulate someone else winning — pretend the row appeared.
                rows.set('rl', {
                  key: 'rl',
                  kind: 'fixed-window',
                  data: 'x',
                  updated_at: 999,
                });
                return { success: true, meta: { changes: 0 } };
              }
              const [key, kind, data, updated_at] = bound as [string, string, string, number];
              rows.set(key, { key, kind, data, updated_at });
              return { success: true, meta: { changes: 1 } };
            }
            return { success: true };
          },
        };
        return stmt;
      },
    };
    const store = createD1Store(d1);
    const r = await store.consume('rl', fixedWindow({ limit: 5, window: '1m' }), 1, 0);
    expect(r.allowed).toBe(true);
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it('should surface STORE_UNAVAILABLE after exhausting CAS retries', async () => {
    const d1: D1Like = {
      prepare(query: string) {
        const stmt: D1PreparedStatementLike = {
          bind() {
            return stmt;
          },
          async first() {
            return null;
          },
          async run() {
            if (query.startsWith('INSERT')) {
              return { success: true, meta: { changes: 0 } };
            }
            return { success: true };
          },
        };
        return stmt;
      },
    };
    const store = createD1Store(d1, { maxRetries: 2 });
    await expect(
      store.consume('k', fixedWindow({ limit: 1, window: '1m' }), 1, 0),
    ).rejects.toThrow(RateLimitError);
  });

  it('should sweep when meta is missing and fall back to 0 changes', async () => {
    const d1: D1Like = {
      prepare(query: string) {
        const stmt: D1PreparedStatementLike = {
          bind() {
            return stmt;
          },
          async first() {
            return null;
          },
          async run() {
            if (query.startsWith('DELETE')) return { success: true };
            return { success: true };
          },
        };
        return stmt;
      },
    };
    const store = createD1Store(d1);
    expect(await store.sweep?.()).toBe(0);
  });

  it('should sweep return 0 when query reports failure', async () => {
    const d1: D1Like = {
      prepare() {
        const stmt: D1PreparedStatementLike = {
          bind() {
            return stmt;
          },
          async first() {
            return null;
          },
          async run() {
            return { success: false };
          },
        };
        return stmt;
      },
    };
    const store = createD1Store(d1);
    expect(await store.sweep?.()).toBe(0);
  });
});

describe('createD1Store — option validation', () => {
  it('should reject illegal table name as INVALID_CONFIG', () => {
    expect(() => createD1Store(makeD1(), { table: '1ratelimit' })).toThrow(RateLimitError);
    expect(() => createD1Store(makeD1(), { table: 'rate-limit' })).toThrow(RateLimitError);
    expect(() => createD1Store(makeD1(), { table: 'foo;DROP TABLE' })).toThrow(RateLimitError);
  });

  it('should accept a custom table name when valid', () => {
    expect(() => createD1Store(makeD1(), { table: 'my_ratelimit' })).not.toThrow();
  });

  it('should reject sliding-window-log limit > 50000 as PAYLOAD_TOO_LARGE', async () => {
    const store = createD1Store(makeD1());
    const tooBig = slidingWindowLog({ limit: 60_000, window: '1m' });
    await expect(store.consume('k', tooBig, 1, 0)).rejects.toThrow(RateLimitError);
    await expect(store.peek('k', tooBig, 0)).rejects.toThrow(RateLimitError);
  });

  it('should apply keyPrefix to stored keys', async () => {
    const d1 = makeD1();
    const store = createD1Store(d1, { keyPrefix: 't:' });
    await store.consume('k', fixedWindow({ limit: 1, window: '1m' }), 1, 0);
    expect([...d1.__rows.keys()][0]).toBe('t:k');
  });
});
