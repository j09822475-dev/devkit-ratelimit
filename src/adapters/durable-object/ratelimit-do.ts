/**
 * Reference Durable Object class. Users re-export this from their worker
 * to bind the DO with Wrangler, or subclass to add custom alarms.
 *
 * The DO holds the rate-limit state in its in-memory `Map` plus the
 * persistent `state.storage` API. All RPCs to a single DO instance
 * serialise naturally inside the actor model — no Lua, no CAS.
 */

import type { AlgorithmSpec } from '../../types/algorithm.js';
import type { ConsumeResult } from '../../types/store.js';
import { RateLimitError } from '../../errors/base.js';

/**
 * Minimum DurableObjectState shape used by the reference DO. Mirrors the
 * type from `@cloudflare/workers-types`.
 */
export interface DurableObjectStateLike {
  storage: {
    get<T = unknown>(key: string): Promise<T | undefined>;
    put<T = unknown>(key: string, value: T): Promise<void>;
    delete(key: string): Promise<boolean>;
  };
  blockConcurrencyWhile?<T>(fn: () => Promise<T>): Promise<T>;
}

/**
 * Reference rate-limit Durable Object. Subclass this to add custom alarms
 * (e.g. periodic export to a metrics sink) or instantiate directly via
 * Wrangler binding.
 *
 * The DO exposes a single async `consume({ key, spec, cost, now })` method
 * — invoked through the DO RPC binding from {@link createDurableObjectStore}.
 */
export class RateLimitDurableObject {
  /**
   * @param state Durable Object state (provided by the runtime).
   */
  constructor(protected readonly state: DurableObjectStateLike) {}

  /**
   * Atomically consume `cost` permits for `key` under the given spec.
   *
   * @param req Body: `{ key, spec, cost, now }`.
   * @returns   The consume result as JSON.
   */
  async fetch(req: Request): Promise<Response> {
    let body: { op: 'consume' | 'peek' | 'reset'; key: string; spec?: AlgorithmSpec; cost?: number; now?: number };
    try {
      body = (await req.json()) as typeof body;
    } catch (err) {
      return new Response(
        JSON.stringify({ error: 'invalid json', detail: String(err) }),
        { status: 400 },
      );
    }
    if (body.op === 'reset') {
      const existed = await this.state.storage.delete(body.key);
      return Response.json({ existed });
    }
    if (body.spec === undefined || body.now === undefined) {
      return Response.json({ error: 'missing spec/now' }, { status: 400 });
    }
    if (body.op === 'consume') {
      const cost = body.cost ?? 1;
      const result = await this.consumeImpl(body.key, body.spec, cost, body.now);
      return Response.json(result);
    }
    if (body.op === 'peek') {
      const result = await this.consumeImpl(body.key, body.spec, 0, body.now);
      return Response.json(result);
    }
    return Response.json({ error: 'unknown op' }, { status: 400 });
  }

  /**
   * Apply the algorithm and persist the new state. Honours the DO's
   * `blockConcurrencyWhile` to serialise concurrent consumes for the same
   * key (the runtime's actor model already serialises across requests
   * targeting one DO instance, but `blockConcurrencyWhile` ensures the
   * read-modify-write sequence is also race-free against constructor-time
   * I/O).
   *
   * @param key  Stored key (the limiter's `prefix:scope:userKey`).
   * @param spec Algorithm spec.
   * @param cost Permits requested.
   * @param now  Wall-clock milliseconds.
   * @returns    The consume result.
   */
  protected async consumeImpl(
    key: string,
    spec: AlgorithmSpec,
    cost: number,
    now: number,
  ): Promise<ConsumeResult> {
    const apply = async (): Promise<ConsumeResult> => {
      const prev = await this.state.storage.get<PersistedData>(key);
      const { result, next } = applyAlgorithm(spec, prev ?? null, cost, now);
      if (cost > 0) await this.state.storage.put(key, next);
      return result;
    };
    if (typeof this.state.blockConcurrencyWhile === 'function') {
      return this.state.blockConcurrencyWhile(apply);
    }
    return apply();
  }
}

interface PersistedData {
  k: AlgorithmSpec['kind'];
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

function applyAlgorithm(
  spec: AlgorithmSpec,
  prev: PersistedData | null,
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
      return applyTokenBucket(spec.capacity, spec.refill, spec.intervalMs, prev, cost, now);
    case 'leaky-bucket':
      return applyLeakyBucket(spec.capacity, spec.leak, spec.intervalMs, prev, cost, now);
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
  const count = prev?.k === 'fixed-window' && prev.s === start ? (prev.l ?? 0) : 0;
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
  prev: PersistedData | null,
  cost: number,
  now: number,
): AppliedResult {
  const start = Math.floor(now / windowMs) * windowMs;
  const reset = start + windowMs;
  let cur = 0;
  let prevCount = 0;
  if (prev !== null && prev.k === 'sliding-window-counter') {
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
  prev: PersistedData | null,
  cost: number,
  now: number,
): AppliedResult {
  const cutoff = now - windowMs;
  const ts: number[] = prev?.k === 'sliding-window-log' ? [...(prev.ts ?? [])] : [];
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
  prev: PersistedData | null,
  cost: number,
  now: number,
): AppliedResult {
  let level = capacity;
  let updatedAt = now;
  if (prev !== null && prev.k === 'token-bucket') {
    level = prev.level ?? capacity;
    updatedAt = prev.updatedAt ?? now;
  }
  const elapsed = Math.max(0, now - updatedAt);
  const settled = Math.min(capacity, level + (elapsed / intervalMs) * refill);
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
  prev: PersistedData | null,
  cost: number,
  now: number,
): AppliedResult {
  let level = 0;
  let updatedAt = now;
  if (prev !== null && prev.k === 'leaky-bucket') {
    level = prev.level ?? 0;
    updatedAt = prev.updatedAt ?? now;
  }
  const elapsed = Math.max(0, now - updatedAt);
  const settled = Math.max(0, level - (elapsed / intervalMs) * leak);
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
