/**
 * Cloudflare D1 store — strong consistency within a single D1 region.
 * Each consume runs an optimistic-concurrency cycle: SELECT current row,
 * compute the post-state in JS, then UPSERT with a guarded
 * `WHERE updated_at = ? AND data = ?` clause that only fires when no
 * concurrent writer has touched the row. A bounded retry loop handles
 * the lost-race case. The schema lives in `schema.sql`; users run it
 * once via `wrangler d1 execute` before first deploy.
 */

import { RateLimitError } from '../../errors/base.js';
import type { AlgorithmSpec } from '../../types/algorithm.js';
import type { RateLimitState } from '../../types/result.js';
import type { ConsumeResult, RateLimitStore } from '../../types/store.js';

/**
 * Minimum D1 binding shape — mirrors `D1Database` from
 * `@cloudflare/workers-types`. Kept narrow so non-CF consumers can pass a
 * mock without installing the workers types.
 */
export interface D1Like {
  prepare(query: string): D1PreparedStatementLike;
}

/**
 * Minimum D1 prepared statement shape.
 */
export interface D1PreparedStatementLike {
  bind(...values: (string | number | null)[]): D1PreparedStatementLike;
  first<T = unknown>(): Promise<T | null>;
  run(): Promise<{ success: boolean; meta?: { changes?: number } }>;
}

/**
 * Configuration options for {@link createD1Store}.
 */
export interface D1StoreOptions {
  /** Table name. Default `'ratelimit'`. */
  readonly table?: string;
  /** Optional adapter-level prefix. */
  readonly keyPrefix?: string;
  /**
   * Maximum optimistic-concurrency retries on a lost write race. Default 5.
   * Exceeding throws `STORE_UNAVAILABLE`.
   */
  readonly maxRetries?: number;
}

interface PersistedRow {
  key: string;
  kind: AlgorithmSpec['kind'];
  data: string;
  updated_at: number;
}

/**
 * Build a Cloudflare-D1-backed {@link RateLimitStore}.
 *
 * @param db   A D1 binding (`env.MY_DB` from a Worker).
 * @param opts Optional configuration.
 * @returns    A {@link RateLimitStore}.
 *
 * Validate `sliding-window-log + limit > 50_000` at consume time — D1
 * row size is bounded at ~1 MB and a JSON-serialised timestamp set
 * approaches that cap; we throw `PAYLOAD_TOO_LARGE` rather than letting
 * the row write fail at runtime with an opaque SQL error.
 */
export function createD1Store(db: D1Like, opts: D1StoreOptions = {}): RateLimitStore {
  const table = sanitiseIdent(opts.table ?? 'ratelimit');
  const keyPrefix = opts.keyPrefix ?? '';
  const maxRetries = opts.maxRetries ?? 5;

  async function loadRow(key: string): Promise<PersistedRow | null> {
    const row = await db
      .prepare(`SELECT key, kind, data, updated_at FROM ${table} WHERE key = ?`)
      .bind(key)
      .first<PersistedRow>();
    return row;
  }

  // Optimistic-concurrency upsert. Returns `true` when the write was applied,
  // `false` when a concurrent writer raced us (caller retries). The
  // `WHERE updated_at = ? AND data = ?` guards a `DO UPDATE` so the
  // post-state is only committed when the row is still in the snapshot we
  // computed against.
  async function casUpsert(
    row: PersistedRow,
    oldUpdatedAt: number,
    oldData: string,
  ): Promise<boolean> {
    const r = await db
      .prepare(
        `INSERT INTO ${table} (key, kind, data, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET kind = excluded.kind, data = excluded.data, updated_at = excluded.updated_at
         WHERE ${table}.updated_at = ? AND ${table}.data = ?`,
      )
      .bind(row.key, row.kind, row.data, row.updated_at, oldUpdatedAt, oldData)
      .run();
    if (!r.success) return false;
    const changes = r.meta?.changes;
    // Workers' D1 always reports `changes` for write statements; fall back
    // to `success` for mocks that don't expose `meta`.
    return changes === undefined ? true : changes > 0;
  }

  return {
    name: 'd1',
    async consume(key, spec, cost, now): Promise<ConsumeResult> {
      assertPayloadSize(spec);
      const fullKey = keyPrefix + key;
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        let row: PersistedRow | null;
        try {
          row = await loadRow(fullKey);
        } catch (err) {
          throw new RateLimitError('STORE_UNAVAILABLE', 'd1: select failed', err);
        }
        const oldUpdatedAt = row?.updated_at ?? -1;
        const oldData = row?.data ?? '';
        const { result, next } = applyAlgorithm(spec, row, cost, now);
        if (cost === 0) return result;
        let won: boolean;
        try {
          won = await casUpsert(
            {
              key: fullKey,
              kind: spec.kind,
              data: JSON.stringify(next),
              updated_at: now,
            },
            oldUpdatedAt,
            oldData,
          );
        } catch (err) {
          throw new RateLimitError('STORE_UNAVAILABLE', 'd1: upsert failed', err);
        }
        if (won) return result;
      }
      throw new RateLimitError(
        'STORE_UNAVAILABLE',
        `d1: write contention exceeded ${maxRetries} retries`,
      );
    },
    async peek(key, spec, now): Promise<RateLimitState> {
      assertPayloadSize(spec);
      const fullKey = keyPrefix + key;
      let row: PersistedRow | null;
      try {
        row = await loadRow(fullKey);
      } catch (err) {
        throw new RateLimitError('STORE_UNAVAILABLE', 'd1: select failed', err);
      }
      const { result } = applyAlgorithm(spec, row, 0, now);
      return {
        limit: result.limit,
        remaining: result.remaining,
        reset: result.reset,
        retryAfter: result.retryAfter,
      };
    },
    async reset(key): Promise<boolean> {
      const fullKey = keyPrefix + key;
      try {
        const r = await db
          .prepare(`DELETE FROM ${table} WHERE key = ?`)
          .bind(fullKey)
          .run();
        return r.success;
      } catch (err) {
        throw new RateLimitError('STORE_UNAVAILABLE', 'd1: delete failed', err);
      }
    },
    async sweep(now): Promise<number> {
      // We sweep entries older than 7 days as a coarse safety valve;
      // adapters with native TTL don't need this.
      const cutoff = (now ?? Date.now()) - 7 * 86_400_000;
      try {
        const r = await db
          .prepare(`DELETE FROM ${table} WHERE updated_at < ?`)
          .bind(cutoff)
          .run();
        if (!r.success) return 0;
        return r.meta?.changes ?? 0;
      } catch {
        return 0;
      }
    },
  };
}

/**
 * Validate the identifier used to interpolate the table name into the SQL
 * string (D1 doesn't support placeholders for identifiers). Allowed:
 * letters, digits and underscore. Anything else throws `INVALID_CONFIG`.
 *
 * @param ident Identifier candidate.
 * @returns     The sanitised identifier.
 */
function sanitiseIdent(ident: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(ident)) {
    throw new RateLimitError(
      'INVALID_CONFIG',
      `d1: invalid table name '${ident}' (allow [A-Za-z_][A-Za-z0-9_]*)`,
    );
  }
  return ident;
}

function assertPayloadSize(spec: AlgorithmSpec): void {
  if (spec.kind === 'sliding-window-log' && spec.limit > 50_000) {
    throw new RateLimitError(
      'PAYLOAD_TOO_LARGE',
      `sliding-window-log limit ${spec.limit} exceeds D1 row-size guard (50 000)`,
    );
  }
}

interface PersistedData {
  l?: number;
  p?: number;
  s?: number;
  ts?: number[];
  level?: number;
  updatedAt?: number;
}

interface AppliedResult {
  next: PersistedData;
  result: ConsumeResult;
}

function decode(row: PersistedRow | null, expectedKind: AlgorithmSpec['kind']): PersistedData | null {
  if (row === null) return null;
  if (row.kind !== expectedKind) return null;
  try {
    return JSON.parse(row.data) as PersistedData;
  } catch {
    return null;
  }
}

function applyAlgorithm(
  spec: AlgorithmSpec,
  row: PersistedRow | null,
  cost: number,
  now: number,
): AppliedResult {
  switch (spec.kind) {
    case 'fixed-window':
      return applyFixedWindow(spec.limit, spec.windowMs, decode(row, 'fixed-window'), cost, now);
    case 'sliding-window-counter':
      return applySlidingCounter(
        spec.limit,
        spec.windowMs,
        decode(row, 'sliding-window-counter'),
        cost,
        now,
      );
    case 'sliding-window-log':
      return applySlidingLog(
        spec.limit,
        spec.windowMs,
        decode(row, 'sliding-window-log'),
        cost,
        now,
      );
    case 'token-bucket':
      return applyTokenBucket(
        spec.capacity,
        spec.refill,
        spec.intervalMs,
        decode(row, 'token-bucket'),
        cost,
        now,
      );
    case 'leaky-bucket':
      return applyLeakyBucket(
        spec.capacity,
        spec.leak,
        spec.intervalMs,
        decode(row, 'leaky-bucket'),
        cost,
        now,
      );
    default: {
      const exhaustive: never = spec;
      void exhaustive;
      throw new RateLimitError('INVALID_CONFIG', 'unknown algorithm kind');
    }
  }
}

function applyFixedWindow(
  limit: number,
  windowMs: number,
  prev: PersistedData | null,
  cost: number,
  now: number,
): AppliedResult {
  const start = Math.floor(now / windowMs) * windowMs;
  const reset = start + windowMs;
  const count = prev?.s === start ? (prev.l ?? 0) : 0;
  if (cost === 0) {
    return {
      next: { l: count, s: start },
      result: {
        allowed: count < limit,
        limit,
        remaining: Math.max(0, limit - count),
        reset,
        retryAfter: count >= limit ? reset - now : 0,
      },
    };
  }
  if (count + cost > limit) {
    return {
      next: { l: count, s: start },
      result: {
        allowed: false,
        limit,
        remaining: Math.max(0, limit - count),
        reset,
        retryAfter: reset - now,
      },
    };
  }
  const newCount = count + cost;
  return {
    next: { l: newCount, s: start },
    result: {
      allowed: true,
      limit,
      remaining: Math.max(0, limit - newCount),
      reset,
      retryAfter: 0,
    },
  };
}

function applySlidingCounter(
  limit: number,
  windowMs: number,
  prev: PersistedData | null,
  cost: number,
  now: number,
): AppliedResult {
  const start = Math.floor(now / windowMs) * windowMs;
  const reset = start + windowMs;
  let cur = 0;
  let prevCount = 0;
  if (prev !== null) {
    if (prev.s === start) {
      cur = prev.l ?? 0;
      prevCount = prev.p ?? 0;
    } else if (prev.s === start - windowMs) {
      prevCount = prev.l ?? 0;
    }
  }
  const elapsedFrac = (now - start) / windowMs;
  const approx = Math.floor(prevCount * (1 - elapsedFrac)) + cur;
  if (cost === 0) {
    return {
      next: { l: cur, p: prevCount, s: start },
      result: {
        allowed: approx < limit,
        limit,
        remaining: Math.max(0, limit - approx),
        reset,
        retryAfter: approx >= limit ? reset - now : 0,
      },
    };
  }
  if (approx + cost > limit) {
    return {
      next: { l: cur, p: prevCount, s: start },
      result: {
        allowed: false,
        limit,
        remaining: Math.max(0, limit - approx),
        reset,
        retryAfter: reset - now,
      },
    };
  }
  const newCur = cur + cost;
  const newApprox = Math.floor(prevCount * (1 - elapsedFrac)) + newCur;
  return {
    next: { l: newCur, p: prevCount, s: start },
    result: {
      allowed: true,
      limit,
      remaining: Math.max(0, limit - newApprox),
      reset,
      retryAfter: 0,
    },
  };
}

function applySlidingLog(
  limit: number,
  windowMs: number,
  prev: PersistedData | null,
  cost: number,
  now: number,
): AppliedResult {
  const cutoff = now - windowMs;
  const ts: number[] = [...(prev?.ts ?? [])];
  while (ts.length > 0) {
    const head = ts[0];
    if (head === undefined || head > cutoff) break;
    ts.shift();
  }
  const oldest = ts[0] ?? now;
  const reset = oldest + windowMs;
  if (cost === 0) {
    return {
      next: { ts },
      result: {
        allowed: ts.length < limit,
        limit,
        remaining: Math.max(0, limit - ts.length),
        reset,
        retryAfter: ts.length >= limit ? reset - now : 0,
      },
    };
  }
  if (ts.length + cost > limit) {
    return {
      next: { ts },
      result: {
        allowed: false,
        limit,
        remaining: Math.max(0, limit - ts.length),
        reset,
        retryAfter: reset - now,
      },
    };
  }
  for (let i = 0; i < cost; i++) ts.push(now);
  return {
    next: { ts },
    result: {
      allowed: true,
      limit,
      remaining: Math.max(0, limit - ts.length),
      reset: (ts[0] ?? now) + windowMs,
      retryAfter: 0,
    },
  };
}

function applyTokenBucket(
  capacity: number,
  refill: number,
  intervalMs: number,
  prev: PersistedData | null,
  cost: number,
  now: number,
): AppliedResult {
  let level = capacity;
  let updatedAt = now;
  if (prev !== null) {
    level = prev.level ?? capacity;
    updatedAt = prev.updatedAt ?? now;
  }
  const elapsed = Math.max(0, now - updatedAt);
  const refillAmount = (elapsed / intervalMs) * refill;
  const settled = Math.min(capacity, level + refillAmount);
  if (cost === 0) {
    return {
      next: { level: settled, updatedAt: now },
      result: {
        allowed: true,
        limit: capacity,
        remaining: Math.floor(settled),
        reset: now,
        retryAfter: 0,
      },
    };
  }
  if (settled < cost) {
    const wait = Math.ceil(((cost - settled) / refill) * intervalMs);
    return {
      next: { level: settled, updatedAt: now },
      result: {
        allowed: false,
        limit: capacity,
        remaining: Math.floor(Math.max(0, settled)),
        reset: now + wait,
        retryAfter: wait,
      },
    };
  }
  const newLevel = settled - cost;
  return {
    next: { level: newLevel, updatedAt: now },
    result: {
      allowed: true,
      limit: capacity,
      remaining: Math.floor(newLevel),
      reset: now,
      retryAfter: 0,
    },
  };
}

function applyLeakyBucket(
  capacity: number,
  leak: number,
  intervalMs: number,
  prev: PersistedData | null,
  cost: number,
  now: number,
): AppliedResult {
  let level = 0;
  let updatedAt = now;
  if (prev !== null) {
    level = prev.level ?? 0;
    updatedAt = prev.updatedAt ?? now;
  }
  const elapsed = Math.max(0, now - updatedAt);
  const leaked = (elapsed / intervalMs) * leak;
  const settled = Math.max(0, level - leaked);
  if (cost === 0) {
    return {
      next: { level: settled, updatedAt: now },
      result: {
        allowed: true,
        limit: capacity,
        remaining: Math.floor(Math.max(0, capacity - settled)),
        reset: now,
        retryAfter: 0,
      },
    };
  }
  if (settled + cost > capacity) {
    const wait = Math.ceil(((settled + cost - capacity) / leak) * intervalMs);
    return {
      next: { level: settled, updatedAt: now },
      result: {
        allowed: false,
        limit: capacity,
        remaining: Math.floor(Math.max(0, capacity - settled)),
        reset: now + wait,
        retryAfter: wait,
      },
    };
  }
  const newLevel = settled + cost;
  return {
    next: { level: newLevel, updatedAt: now },
    result: {
      allowed: true,
      limit: capacity,
      remaining: Math.floor(Math.max(0, capacity - newLevel)),
      reset: now,
      retryAfter: 0,
    },
  };
}
