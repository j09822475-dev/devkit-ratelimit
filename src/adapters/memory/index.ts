/**
 * In-process LRU store. Single-threaded JS guarantees every operation is
 * atomic by construction. `maxSize` caps memory by evicting the
 * least-recently touched key once the store reaches the bound.
 */

import { RateLimitError } from '../../errors/base.js';
import type { AlgorithmSpec } from '../../types/algorithm.js';
import type { RateLimitState } from '../../types/result.js';
import type { ConsumeResult, RateLimitStore } from '../../types/store.js';
import { Lru } from '../../utils/lru.js';

interface FixedWindowEntry {
  kind: 'fixed-window' | 'sliding-window-counter';
  /** Aligned window start (ms). */
  start: number;
  /** Counter for the current (aligned) window. */
  count: number;
  /** Counter for the previous (aligned) window — used by sliding-window. */
  prev: number;
}

interface SlidingLogEntry {
  kind: 'sliding-window-log';
  timestamps: number[];
}

interface BucketEntry {
  kind: 'token-bucket' | 'leaky-bucket';
  /** Token-bucket: tokens remaining. Leaky-bucket: water level. */
  level: number;
  /** Last time the bucket was settled (refilled / leaked). */
  updatedAt: number;
}

type Entry = FixedWindowEntry | SlidingLogEntry | BucketEntry;

/**
 * Configuration options for {@link createMemoryStore}.
 */
export interface MemoryStoreOptions {
  /**
   * Maximum number of distinct keys held simultaneously. Default 10 000.
   * Inserting beyond evicts the least-recently-touched entry.
   */
  readonly maxSize?: number;
  /**
   * Periodic sweep interval for expired entries, in milliseconds. Default
   * 30 000 ms. Set to `0` to disable for short-lived processes.
   */
  readonly sweepIntervalMs?: number;
}

/**
 * Build an in-process memory-backed {@link RateLimitStore}. Single-process
 * only — multi-instance Node deployments (PM2 cluster, multiple workers)
 * accumulate per-process state; pick Redis / KV / DO instead for those.
 *
 * @param opts Configuration options.
 * @returns    A {@link RateLimitStore}.
 * @example
 *   const store = createMemoryStore({ maxSize: 50_000 });
 */
export function createMemoryStore(opts: MemoryStoreOptions = {}): RateLimitStore {
  const maxSize = opts.maxSize ?? 10_000;
  const sweepIntervalMs = opts.sweepIntervalMs ?? 30_000;
  const lru = new Lru<string, Entry>(maxSize);
  // Periodic sweep: only timer used in core/adapters per the Biome rule.
  let timer: ReturnType<typeof setInterval> | undefined;
  if (sweepIntervalMs > 0 && typeof setInterval !== 'undefined') {
    timer = setInterval(() => sweep(lru, Date.now()), sweepIntervalMs);
    // `unref` exists on Node only; guard for Workers/Deno.
    const t = timer as unknown as { unref?: () => void };
    if (typeof t.unref === 'function') t.unref();
  }
  void timer; // keep the reference; runtime decides cleanup.

  return {
    name: 'memory',
    async consume(key, spec, cost, now): Promise<ConsumeResult> {
      return consumeImpl(lru, key, spec, cost, now, false);
    },
    async peek(key, spec, now): Promise<RateLimitState> {
      // `peek` MUST NOT mutate state — that includes the LRU's MRU order.
      // The `readOnly` flag tells the per-algorithm runners to use
      // `lru.peek` (no promotion) instead of `lru.get`.
      const r = consumeImpl(lru, key, spec, 0, now, true);
      return { limit: r.limit, remaining: r.remaining, reset: r.reset, retryAfter: r.retryAfter };
    },
    async reset(key): Promise<boolean> {
      return lru.delete(key);
    },
    async sweep(now): Promise<number> {
      return sweep(lru, now ?? Date.now());
    },
  };
}

/**
 * Periodic sweep — drop entries whose state has fully decayed. Cheap O(n)
 * pass; bounded by `maxSize`.
 */
function sweep(lru: Lru<string, Entry>, now: number): number {
  let dropped = 0;
  const toDrop: string[] = [];
  for (const [key, entry] of lru.entries()) {
    if (isEntryExpired(entry, now)) {
      toDrop.push(key);
    }
  }
  for (const key of toDrop) {
    if (lru.delete(key)) dropped++;
  }
  return dropped;
}

function isEntryExpired(entry: Entry, now: number): boolean {
  switch (entry.kind) {
    case 'sliding-window-counter':
    case 'fixed-window':
      // After two full windows the entry contributes nothing.
      return false; // we don't know windowMs here; cheap approximation: never expire on sweep.
    case 'sliding-window-log':
      // No timestamps left → can drop.
      return entry.timestamps.length === 0;
    case 'token-bucket':
    case 'leaky-bucket':
      // Don't sweep — bucket state is needed for future refill calc.
      void now;
      return false;
  }
}

function consumeImpl(
  lru: Lru<string, Entry>,
  key: string,
  spec: AlgorithmSpec,
  cost: number,
  now: number,
  readOnly: boolean,
): ConsumeResult {
  switch (spec.kind) {
    case 'fixed-window':
      return runFixedWindow(lru, key, spec.limit, spec.windowMs, cost, now, readOnly);
    case 'sliding-window-counter':
      return runSlidingWindowCounter(lru, key, spec.limit, spec.windowMs, cost, now, readOnly);
    case 'sliding-window-log':
      return runSlidingWindowLog(lru, key, spec.limit, spec.windowMs, cost, now, readOnly);
    case 'token-bucket':
      return runTokenBucket(
        lru,
        key,
        spec.capacity,
        spec.refill,
        spec.intervalMs,
        cost,
        now,
        readOnly,
      );
    case 'leaky-bucket':
      return runLeakyBucket(
        lru,
        key,
        spec.capacity,
        spec.leak,
        spec.intervalMs,
        cost,
        now,
        readOnly,
      );
    default: {
      const exhaustive: never = spec;
      void exhaustive;
      throw new RateLimitError('INVALID_CONFIG', 'unknown algorithm kind');
    }
  }
}

/**
 * Read an entry from the LRU. `readOnly` selects between `peek` (no MRU
 * promotion) and `get` (promotes to MRU). The store's `peek` method
 * passes `readOnly: true` so a polling caller doesn't keep an idle key
 * alive at the expense of evicting active ones.
 */
function readEntry(
  lru: Lru<string, Entry>,
  key: string,
  readOnly: boolean,
): Entry | undefined {
  return readOnly ? lru.peek(key) : lru.get(key);
}

function runFixedWindow(
  lru: Lru<string, Entry>,
  key: string,
  limit: number,
  windowMs: number,
  cost: number,
  now: number,
  readOnly: boolean,
): ConsumeResult {
  const start = Math.floor(now / windowMs) * windowMs;
  const reset = start + windowMs;
  const existing = readEntry(lru, key, readOnly);
  let count = 0;
  if (existing !== undefined && existing.kind === 'fixed-window' && existing.start === start) {
    count = existing.count;
  }
  if (cost === 0) {
    return {
      allowed: true,
      limit,
      remaining: Math.max(0, limit - count),
      reset,
      retryAfter: count >= limit ? reset - now : 0,
    };
  }
  if (count + cost > limit) {
    // Persist whatever we have so the entry is touched (LRU promotion).
    if (existing === undefined || existing.kind !== 'fixed-window' || existing.start !== start) {
      lru.set(key, { kind: 'fixed-window', start, count, prev: 0 });
    } else {
      lru.set(key, existing);
    }
    return {
      allowed: false,
      limit,
      remaining: Math.max(0, limit - count),
      reset,
      retryAfter: reset - now,
    };
  }
  const next = count + cost;
  lru.set(key, { kind: 'fixed-window', start, count: next, prev: 0 });
  return {
    allowed: true,
    limit,
    remaining: Math.max(0, limit - next),
    reset,
    retryAfter: 0,
  };
}

function runSlidingWindowCounter(
  lru: Lru<string, Entry>,
  key: string,
  limit: number,
  windowMs: number,
  cost: number,
  now: number,
  readOnly: boolean,
): ConsumeResult {
  const start = Math.floor(now / windowMs) * windowMs;
  const reset = start + windowMs;
  let count = 0;
  let prev = 0;
  const existing = readEntry(lru, key, readOnly);
  if (existing !== undefined && existing.kind === 'sliding-window-counter') {
    if (existing.start === start) {
      count = existing.count;
      prev = existing.prev;
    } else if (existing.start === start - windowMs) {
      // The "previous window" is what was the current one.
      prev = existing.count;
    }
    // Otherwise both windows have lapsed.
  }
  // Fraction of the current window already elapsed.
  const elapsedFrac = (now - start) / windowMs;
  // Approximate count "in the trailing window".
  const approx = Math.floor(prev * (1 - elapsedFrac)) + count;
  if (cost === 0) {
    return {
      allowed: true,
      limit,
      remaining: Math.max(0, limit - approx),
      reset,
      retryAfter: approx >= limit ? reset - now : 0,
    };
  }
  if (approx + cost > limit) {
    lru.set(key, { kind: 'sliding-window-counter', start, count, prev });
    return {
      allowed: false,
      limit,
      remaining: Math.max(0, limit - approx),
      reset,
      retryAfter: reset - now,
    };
  }
  const nextCount = count + cost;
  lru.set(key, { kind: 'sliding-window-counter', start, count: nextCount, prev });
  const newApprox = Math.floor(prev * (1 - elapsedFrac)) + nextCount;
  return {
    allowed: true,
    limit,
    remaining: Math.max(0, limit - newApprox),
    reset,
    retryAfter: 0,
  };
}

function runSlidingWindowLog(
  lru: Lru<string, Entry>,
  key: string,
  limit: number,
  windowMs: number,
  cost: number,
  now: number,
  readOnly: boolean,
): ConsumeResult {
  const cutoff = now - windowMs;
  const existing = readEntry(lru, key, readOnly);
  let timestamps: number[] = [];
  if (existing !== undefined && existing.kind === 'sliding-window-log') {
    timestamps = existing.timestamps;
  }
  // Drop expired entries. Linear-time but bounded by `limit`.
  let firstActive = 0;
  while (firstActive < timestamps.length) {
    const ts = timestamps[firstActive];
    if (ts === undefined || ts > cutoff) break;
    firstActive++;
  }
  if (firstActive > 0) timestamps = timestamps.slice(firstActive);

  const oldest = timestamps[0] ?? now;
  const reset = oldest + windowMs;

  if (cost === 0) {
    const remaining = Math.max(0, limit - timestamps.length);
    return {
      allowed: true,
      limit,
      remaining,
      reset,
      retryAfter: timestamps.length >= limit ? reset - now : 0,
    };
  }
  if (timestamps.length + cost > limit) {
    lru.set(key, { kind: 'sliding-window-log', timestamps });
    return {
      allowed: false,
      limit,
      remaining: Math.max(0, limit - timestamps.length),
      reset,
      retryAfter: reset - now,
    };
  }
  // Append `cost` timestamps (we treat each cost unit as one event).
  for (let i = 0; i < cost; i++) timestamps.push(now);
  lru.set(key, { kind: 'sliding-window-log', timestamps });
  const remaining = Math.max(0, limit - timestamps.length);
  return {
    allowed: true,
    limit,
    remaining,
    reset: timestamps[0] !== undefined ? timestamps[0] + windowMs : now + windowMs,
    retryAfter: 0,
  };
}

function runTokenBucket(
  lru: Lru<string, Entry>,
  key: string,
  capacity: number,
  refill: number,
  intervalMs: number,
  cost: number,
  now: number,
  readOnly: boolean,
): ConsumeResult {
  const existing = readEntry(lru, key, readOnly);
  let level = capacity;
  let updatedAt = now;
  if (existing !== undefined && existing.kind === 'token-bucket') {
    level = existing.level;
    updatedAt = existing.updatedAt;
  }
  // Clamp `elapsed` ≥ 0 to absorb backwards clock jumps (NTP).
  const elapsed = Math.max(0, now - updatedAt);
  const refillAmount = (elapsed / intervalMs) * refill;
  const settled = Math.min(capacity, level + refillAmount);

  if (cost === 0) {
    const remaining = Math.floor(settled);
    return {
      allowed: true,
      limit: capacity,
      remaining,
      reset: now + msUntilRefill(settled, capacity, refill, intervalMs),
      retryAfter: settled <= 0 ? msUntilRefill(settled, 1, refill, intervalMs) : 0,
    };
  }

  if (settled < cost) {
    lru.set(key, { kind: 'token-bucket', level: settled, updatedAt: now });
    const deficit = cost - settled;
    const wait = (deficit / refill) * intervalMs;
    return {
      allowed: false,
      limit: capacity,
      remaining: Math.floor(Math.max(0, settled)),
      reset: now + Math.ceil(wait),
      retryAfter: Math.ceil(wait),
    };
  }
  const next = settled - cost;
  lru.set(key, { kind: 'token-bucket', level: next, updatedAt: now });
  return {
    allowed: true,
    limit: capacity,
    remaining: Math.floor(next),
    reset: now + msUntilRefill(next, capacity, refill, intervalMs),
    retryAfter: 0,
  };
}

function msUntilRefill(
  level: number,
  capacity: number,
  refill: number,
  intervalMs: number,
): number {
  if (level >= capacity) return 0;
  const deficit = capacity - level;
  return Math.ceil((deficit / refill) * intervalMs);
}

function runLeakyBucket(
  lru: Lru<string, Entry>,
  key: string,
  capacity: number,
  leak: number,
  intervalMs: number,
  cost: number,
  now: number,
  readOnly: boolean,
): ConsumeResult {
  const existing = readEntry(lru, key, readOnly);
  let level = 0;
  let updatedAt = now;
  if (existing !== undefined && existing.kind === 'leaky-bucket') {
    level = existing.level;
    updatedAt = existing.updatedAt;
  }
  const elapsed = Math.max(0, now - updatedAt);
  const leaked = (elapsed / intervalMs) * leak;
  const settled = Math.max(0, level - leaked);

  const room = capacity - settled;
  if (cost === 0) {
    return {
      allowed: true,
      limit: capacity,
      remaining: Math.floor(Math.max(0, room)),
      reset: now + Math.ceil((settled / leak) * intervalMs),
      retryAfter: 0,
    };
  }
  if (settled + cost > capacity) {
    lru.set(key, { kind: 'leaky-bucket', level: settled, updatedAt: now });
    const overflow = settled + cost - capacity;
    const wait = (overflow / leak) * intervalMs;
    return {
      allowed: false,
      limit: capacity,
      remaining: Math.floor(Math.max(0, room)),
      reset: now + Math.ceil(wait),
      retryAfter: Math.ceil(wait),
    };
  }
  const next = settled + cost;
  lru.set(key, { kind: 'leaky-bucket', level: next, updatedAt: now });
  return {
    allowed: true,
    limit: capacity,
    remaining: Math.floor(Math.max(0, capacity - next)),
    reset: now + Math.ceil((next / leak) * intervalMs),
    retryAfter: 0,
  };
}
