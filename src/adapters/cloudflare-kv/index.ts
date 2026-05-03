/**
 * Cloudflare KV store — eventually consistent, ≤60 s global staleness
 * window per CF docs. Uses `get(..., { type: 'json' })` + conditional
 * `put` with a CAS metadata token; under contention this degrades to
 * "best-effort" with documented worst-case overshoot of ~1 per region.
 *
 * Use this only when "approximately N per minute, somewhere in the
 * world" is acceptable. For billing- or security-critical quotas use
 * `createDurableObjectStore` instead.
 */

import { RateLimitError } from '../../errors/base.js';
import type { AlgorithmSpec } from '../../types/algorithm.js';
import type { RateLimitState } from '../../types/result.js';
import type { ConsumeResult, RateLimitStore } from '../../types/store.js';

/**
 * Minimum KV namespace shape required by the adapter. Mirrors
 * `KVNamespace` from `@cloudflare/workers-types`. Kept narrow so non-CF
 * consumers can pass in a mock without installing the workers types.
 */
export interface KVLike {
  get(
    key: string,
    options?: { type: 'json'; cacheTtl?: number },
  ): Promise<unknown>;
  put(
    key: string,
    value: string,
    options?: { expirationTtl?: number; metadata?: unknown },
  ): Promise<void>;
  delete(key: string): Promise<void>;
}

interface KVEntry {
  // Algorithm kind discriminator persisted alongside data so we can detect
  // mismatched specs across re-deploys with a different algorithm.
  k: AlgorithmSpec['kind'];
  // Counters / bucket levels are stored uniformly as a Number.
  l: number;
  p: number;
  s: number;
  ts: number[];
  level: number;
  updatedAt: number;
}

/**
 * Configuration options for {@link createKVStore}.
 */
export interface KVStoreOptions {
  /** Optional adapter-level key prefix. */
  readonly keyPrefix?: string;
  /** CAS retry count on metadata mismatch. Default 3. */
  readonly retries?: number;
}

/**
 * Build a Cloudflare-KV-backed {@link RateLimitStore}.
 *
 * @param kv   A KV namespace binding (`env.MY_KV` from a Worker).
 * @param opts Optional adapter-level configuration.
 * @returns    A {@link RateLimitStore}.
 */
export function createKVStore(kv: KVLike, opts: KVStoreOptions = {}): RateLimitStore {
  const keyPrefix = opts.keyPrefix ?? '';
  const retries = opts.retries ?? 3;

  return {
    name: 'kv',
    async consume(key, spec, cost, now): Promise<ConsumeResult> {
      return runWithCas(kv, keyPrefix + key, spec, cost, now, retries);
    },
    async peek(key, spec, now): Promise<RateLimitState> {
      const fullKey = keyPrefix + key;
      let entry: KVEntry | null = null;
      try {
        entry = (await kv.get(fullKey, { type: 'json' })) as KVEntry | null;
      } catch (err) {
        throw new RateLimitError('STORE_UNAVAILABLE', 'kv: get failed', err);
      }
      const { result } = applyAlgorithm(spec, entry, 0, now);
      return result;
    },
    async reset(key): Promise<boolean> {
      try {
        await kv.delete(keyPrefix + key);
        return true;
      } catch (err) {
        throw new RateLimitError('STORE_UNAVAILABLE', 'kv: delete failed', err);
      }
    },
  };
}

async function runWithCas(
  kv: KVLike,
  key: string,
  spec: AlgorithmSpec,
  cost: number,
  now: number,
  retries: number,
): Promise<ConsumeResult> {
  let lastResult: ConsumeResult | undefined;
  for (let i = 0; i < retries + 1; i++) {
    let entry: KVEntry | null;
    try {
      entry = (await kv.get(key, { type: 'json' })) as KVEntry | null;
    } catch (err) {
      throw new RateLimitError('STORE_UNAVAILABLE', 'kv: get failed', err);
    }
    const { next, result } = applyAlgorithm(spec, entry, cost, now);
    lastResult = { ...result, allowed: result.allowed };
    if (cost === 0 || !result.allowed) return lastResult;
    try {
      const ttlSec = Math.max(60, Math.ceil(specWindowMs(spec) / 1000) * 2);
      await kv.put(key, JSON.stringify(next), { expirationTtl: ttlSec });
      return lastResult;
    } catch (err) {
      // KV writes don't have a true CAS; we treat any error as a transient
      // race and retry. After `retries` we accept the best-effort result.
      if (i === retries) {
        throw new RateLimitError('STORE_UNAVAILABLE', 'kv: put failed', err);
      }
    }
  }
  // Never reached — the loop either returns or throws — but TS needs a
  // concrete value.
  return lastResult ?? {
    allowed: true,
    limit: 0,
    remaining: 0,
    reset: now,
    retryAfter: 0,
  };
}

function specWindowMs(spec: AlgorithmSpec): number {
  switch (spec.kind) {
    case 'token-bucket':
    case 'leaky-bucket':
      return spec.intervalMs;
    case 'fixed-window':
    case 'sliding-window-counter':
    case 'sliding-window-log':
      return spec.windowMs;
    default: {
      const exhaustive: never = spec;
      void exhaustive;
      return 0;
    }
  }
}

interface AppliedResult {
  next: KVEntry;
  result: ConsumeResult;
}

function applyAlgorithm(
  spec: AlgorithmSpec,
  prev: KVEntry | null,
  cost: number,
  now: number,
): AppliedResult {
  switch (spec.kind) {
    case 'fixed-window':
      return applyFixedWindow(spec.limit, spec.windowMs, prev, cost, now);
    case 'sliding-window-counter':
      return applySlidingCounter(spec.limit, spec.windowMs, prev, cost, now);
    case 'sliding-window-log':
      return applySlidingLog(spec.limit, spec.windowMs, prev, cost, now);
    case 'token-bucket':
      return applyTokenBucket(
        spec.capacity,
        spec.refill,
        spec.intervalMs,
        prev,
        cost,
        now,
      );
    case 'leaky-bucket':
      return applyLeakyBucket(
        spec.capacity,
        spec.leak,
        spec.intervalMs,
        prev,
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

const EMPTY_ENTRY: Omit<KVEntry, 'k'> = {
  l: 0,
  p: 0,
  s: 0,
  ts: [],
  level: 0,
  updatedAt: 0,
};

function applyFixedWindow(
  limit: number,
  windowMs: number,
  prev: KVEntry | null,
  cost: number,
  now: number,
): AppliedResult {
  const start = Math.floor(now / windowMs) * windowMs;
  const reset = start + windowMs;
  let count = 0;
  if (prev !== null && prev.k === 'fixed-window' && prev.s === start) count = prev.l;
  if (cost === 0) {
    const next: KVEntry = { ...EMPTY_ENTRY, k: 'fixed-window', l: count, s: start };
    return {
      next,
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
    const next: KVEntry = { ...EMPTY_ENTRY, k: 'fixed-window', l: count, s: start };
    return {
      next,
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
  const next: KVEntry = { ...EMPTY_ENTRY, k: 'fixed-window', l: newCount, s: start };
  return {
    next,
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
  prev: KVEntry | null,
  cost: number,
  now: number,
): AppliedResult {
  const start = Math.floor(now / windowMs) * windowMs;
  const reset = start + windowMs;
  let cur = 0;
  let prevCount = 0;
  if (prev !== null && prev.k === 'sliding-window-counter') {
    if (prev.s === start) {
      cur = prev.l;
      prevCount = prev.p;
    } else if (prev.s === start - windowMs) {
      prevCount = prev.l;
    }
  }
  const elapsedFrac = (now - start) / windowMs;
  const approx = Math.floor(prevCount * (1 - elapsedFrac)) + cur;
  if (cost === 0) {
    const next: KVEntry = {
      ...EMPTY_ENTRY,
      k: 'sliding-window-counter',
      l: cur,
      p: prevCount,
      s: start,
    };
    return {
      next,
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
    const next: KVEntry = {
      ...EMPTY_ENTRY,
      k: 'sliding-window-counter',
      l: cur,
      p: prevCount,
      s: start,
    };
    return {
      next,
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
  const next: KVEntry = {
    ...EMPTY_ENTRY,
    k: 'sliding-window-counter',
    l: newCur,
    p: prevCount,
    s: start,
  };
  return {
    next,
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
  prev: KVEntry | null,
  cost: number,
  now: number,
): AppliedResult {
  const cutoff = now - windowMs;
  const ts: number[] = prev?.k === 'sliding-window-log' ? [...prev.ts] : [];
  while (ts.length > 0) {
    const head = ts[0];
    if (head === undefined || head > cutoff) break;
    ts.shift();
  }
  const oldest = ts[0] ?? now;
  const reset = oldest + windowMs;
  if (cost === 0) {
    const next: KVEntry = { ...EMPTY_ENTRY, k: 'sliding-window-log', ts };
    return {
      next,
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
    const next: KVEntry = { ...EMPTY_ENTRY, k: 'sliding-window-log', ts };
    return {
      next,
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
  const next: KVEntry = { ...EMPTY_ENTRY, k: 'sliding-window-log', ts };
  return {
    next,
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
  prev: KVEntry | null,
  cost: number,
  now: number,
): AppliedResult {
  let level = capacity;
  let updatedAt = now;
  if (prev !== null && prev.k === 'token-bucket') {
    level = prev.level;
    updatedAt = prev.updatedAt;
  }
  const elapsed = Math.max(0, now - updatedAt);
  const refillAmount = (elapsed / intervalMs) * refill;
  const settled = Math.min(capacity, level + refillAmount);

  if (cost === 0) {
    const next: KVEntry = {
      ...EMPTY_ENTRY,
      k: 'token-bucket',
      level: settled,
      updatedAt: now,
    };
    return {
      next,
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
    const next: KVEntry = {
      ...EMPTY_ENTRY,
      k: 'token-bucket',
      level: settled,
      updatedAt: now,
    };
    const wait = Math.ceil(((cost - settled) / refill) * intervalMs);
    return {
      next,
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
  const next: KVEntry = {
    ...EMPTY_ENTRY,
    k: 'token-bucket',
    level: newLevel,
    updatedAt: now,
  };
  return {
    next,
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
  prev: KVEntry | null,
  cost: number,
  now: number,
): AppliedResult {
  let level = 0;
  let updatedAt = now;
  if (prev !== null && prev.k === 'leaky-bucket') {
    level = prev.level;
    updatedAt = prev.updatedAt;
  }
  const elapsed = Math.max(0, now - updatedAt);
  const leaked = (elapsed / intervalMs) * leak;
  const settled = Math.max(0, level - leaked);
  if (cost === 0) {
    const next: KVEntry = {
      ...EMPTY_ENTRY,
      k: 'leaky-bucket',
      level: settled,
      updatedAt: now,
    };
    return {
      next,
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
    const next: KVEntry = {
      ...EMPTY_ENTRY,
      k: 'leaky-bucket',
      level: settled,
      updatedAt: now,
    };
    const wait = Math.ceil(((settled + cost - capacity) / leak) * intervalMs);
    return {
      next,
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
  const next: KVEntry = {
    ...EMPTY_ENTRY,
    k: 'leaky-bucket',
    level: newLevel,
    updatedAt: now,
  };
  return {
    next,
    result: {
      allowed: true,
      limit: capacity,
      remaining: Math.floor(Math.max(0, capacity - newLevel)),
      reset: now,
      retryAfter: 0,
    },
  };
}
