/**
 * Cloudflare KV store — eventually consistent, ≤60 s global staleness
 * window per CF docs. Workers KV exposes no conditional-put primitive,
 * so the adapter does a best-effort `get → mutate → put` with a bounded
 * retry loop on transport errors only. Two concurrent consumes from the
 * same colocation can both read level N and both write level N+1; under
 * heavy contention worst-case overshoot is `concurrentRequests` per
 * region (NOT the ~1 the original draft claimed).
 *
 * Use this only when "approximately N per minute, somewhere in the
 * world" is acceptable. For billing- or security-critical quotas use
 * `createDurableObjectStore` instead — Durable Objects serialise per-key
 * RPCs by the runtime's actor model and give you a true consistency
 * guarantee.
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

/**
 * Discriminated-union KV entry. Each variant persists ONLY the fields its
 * algorithm needs, so we don't pay for `ts: []` on every token-bucket
 * write or `level: 0` on every fixed-window write. KV charges by stored
 * bytes; trimming pays off across millions of keys.
 */
type KVEntry =
  | { k: 'fixed-window'; l: number; s: number }
  | { k: 'sliding-window-counter'; l: number; p: number; s: number }
  | { k: 'sliding-window-log'; ts: number[] }
  | { k: 'token-bucket'; level: number; updatedAt: number }
  | { k: 'leaky-bucket'; level: number; updatedAt: number };

/**
 * Configuration options for {@link createKVStore}.
 */
export interface KVStoreOptions {
  /** Optional adapter-level key prefix. */
  readonly keyPrefix?: string;
  /**
   * Bounded retry count for transport-level `put` failures. Default 3.
   * KV exposes no CAS primitive, so retries do NOT serialise concurrent
   * writers — they only paper over transient network failures.
   */
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
      assertWindowFitsKV(spec);
      return runBestEffort(kv, keyPrefix + key, spec, cost, now, retries);
    },
    async peek(key, spec, now): Promise<RateLimitState> {
      assertWindowFitsKV(spec);
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

/**
 * Best-effort `get → mutate → put` with bounded retry on transport
 * errors. KV exposes no CAS primitive; the retry only papers over
 * transient `put` failures. Concurrent writers are NOT serialised — see
 * the file-level docblock for the consistency caveat.
 */
async function runBestEffort(
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
      // Transport-level put failure (KV throws on network errors). Retry
      // up to `retries`, then surface as STORE_UNAVAILABLE.
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

// Cloudflare KV `expirationTtl` caps at 365 days. The adapter doubles
// the window when computing the TTL (so a fresh write outlives the
// algorithm's usable horizon); we therefore cap the input window at
// half that ceiling so we never produce an unrepresentable TTL.
const KV_MAX_WINDOW_MS = 180 * 86_400_000;

function assertWindowFitsKV(spec: AlgorithmSpec): void {
  const w = specWindowMs(spec);
  if (w > KV_MAX_WINDOW_MS) {
    throw new RateLimitError(
      'WINDOW_TOO_LARGE',
      `kv: window/intervalMs ${w} exceeds Cloudflare KV expirationTtl ceiling (${KV_MAX_WINDOW_MS} ms ~= 180d, half of the 365d KV cap to leave headroom for the doubled write TTL)`,
    );
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
    return {
      next: { k: 'fixed-window', l: count, s: start },
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
      next: { k: 'fixed-window', l: count, s: start },
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
    next: { k: 'fixed-window', l: newCount, s: start },
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
    return {
      next: { k: 'sliding-window-counter', l: cur, p: prevCount, s: start },
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
      next: { k: 'sliding-window-counter', l: cur, p: prevCount, s: start },
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
    next: { k: 'sliding-window-counter', l: newCur, p: prevCount, s: start },
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
    return {
      next: { k: 'sliding-window-log', ts },
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
      next: { k: 'sliding-window-log', ts },
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
    next: { k: 'sliding-window-log', ts },
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
    return {
      next: { k: 'token-bucket', level: settled, updatedAt: now },
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
      next: { k: 'token-bucket', level: settled, updatedAt: now },
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
    next: { k: 'token-bucket', level: newLevel, updatedAt: now },
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
    return {
      next: { k: 'leaky-bucket', level: settled, updatedAt: now },
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
      next: { k: 'leaky-bucket', level: settled, updatedAt: now },
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
    next: { k: 'leaky-bucket', level: newLevel, updatedAt: now },
    result: {
      allowed: true,
      limit: capacity,
      remaining: Math.floor(Math.max(0, capacity - newLevel)),
      reset: now,
      retryAfter: 0,
    },
  };
}
