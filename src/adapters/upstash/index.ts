/**
 * Upstash REST store — same Lua scripts as the Redis adapter, executed via
 * Upstash's `eval` REST primitive. One HTTP round-trip per check; expect
 * 25–60 ms within the same region, higher cross-region.
 */

import { RateLimitError } from '../../errors/base.js';
import type { AlgorithmSpec, AlgorithmKind } from '../../types/algorithm.js';
import type { RateLimitState } from '../../types/result.js';
import type { ConsumeResult, RateLimitStore } from '../../types/store.js';
import { LUA_SCRIPTS } from './lua.js';

/**
 * Minimum Upstash client shape — the official `@upstash/redis` package
 * satisfies this. Kept narrow so consumers can swap in a mock.
 */
export interface UpstashLike {
  eval(script: string, keys: string[], args: (string | number)[]): Promise<unknown>;
  evalsha?(sha: string, keys: string[], args: (string | number)[]): Promise<unknown>;
  scriptLoad?(script: string): Promise<string>;
}

/**
 * Configuration options for {@link createUpstashStore}.
 */
export interface UpstashStoreOptions {
  /**
   * Optional adapter-level prefix. See {@link RedisStoreOptions.keyPrefix}.
   */
  readonly keyPrefix?: string;
}

/**
 * Build an Upstash-backed {@link RateLimitStore}.
 *
 * @param redis A `@upstash/redis` `Redis` instance (or any
 *              {@link UpstashLike} client).
 * @param opts  Optional adapter-level configuration.
 * @returns     A {@link RateLimitStore}.
 * @example
 *   import { Redis } from '@upstash/redis';
 *   const store = createUpstashStore(Redis.fromEnv());
 */
export function createUpstashStore(
  redis: UpstashLike,
  opts: UpstashStoreOptions = {},
): RateLimitStore {
  const keyPrefix = opts.keyPrefix ?? '';
  const shaCache = new Map<AlgorithmKind, string>();

  async function evalScript(
    spec: AlgorithmSpec,
    key: string,
    args: (string | number)[],
  ): Promise<unknown> {
    const script = LUA_SCRIPTS[spec.kind];
    let sha = shaCache.get(spec.kind);
    if (sha === undefined && typeof redis.scriptLoad === 'function') {
      try {
        sha = await redis.scriptLoad(script);
        shaCache.set(spec.kind, sha);
      } catch {
        // Fall through to EVAL.
      }
    }
    if (sha !== undefined && typeof redis.evalsha === 'function') {
      try {
        return await redis.evalsha(sha, [key], args);
      } catch (err) {
        if (isNoScriptError(err)) {
          shaCache.delete(spec.kind);
          return redis.eval(script, [key], args);
        }
        throw err;
      }
    }
    return redis.eval(script, [key], args);
  }

  return {
    name: 'upstash',
    async consume(key, spec, cost, now): Promise<ConsumeResult> {
      const args = buildArgs(spec, cost, now);
      const fullKey = keyPrefix + key;
      const reply = await evalScript(spec, fullKey, args);
      return parseReply(reply, spec);
    },
    async peek(key, spec, now): Promise<RateLimitState> {
      const args = buildArgs(spec, 0, now);
      const fullKey = keyPrefix + key;
      const reply = await evalScript(spec, fullKey, args);
      const r = parseReply(reply, spec);
      return { limit: r.limit, remaining: r.remaining, reset: r.reset, retryAfter: r.retryAfter };
    },
    async reset(key): Promise<boolean> {
      const fullKey = keyPrefix + key;
      try {
        const reply = await redis.eval(
          `return redis.call('DEL', KEYS[1])`,
          [fullKey],
          [],
        );
        return Number(reply) > 0;
      } catch (err) {
        if (RateLimitError.is(err)) throw err;
        throw new RateLimitError('STORE_UNAVAILABLE', 'upstash: reset failed', err);
      }
    },
  };
}

function buildArgs(spec: AlgorithmSpec, cost: number, now: number): (string | number)[] {
  switch (spec.kind) {
    case 'fixed-window':
    case 'sliding-window-counter':
    case 'sliding-window-log':
      return [now, cost, spec.limit, spec.windowMs];
    case 'token-bucket':
      return [now, cost, spec.capacity, spec.refill, spec.intervalMs];
    case 'leaky-bucket':
      return [now, cost, spec.capacity, spec.leak, spec.intervalMs];
    default: {
      const exhaustive: never = spec;
      void exhaustive;
      throw new RateLimitError('INVALID_CONFIG', 'unknown algorithm kind');
    }
  }
}

function parseReply(reply: unknown, spec: AlgorithmSpec): ConsumeResult {
  if (!Array.isArray(reply) || reply.length < 4) {
    throw new RateLimitError(
      'STORE_UNAVAILABLE',
      `upstash: malformed reply (${typeof reply})`,
    );
  }
  const allowed = Number(reply[0]) === 1;
  const remaining = Number(reply[1]);
  const reset = Number(reply[2]);
  const retryAfter = Number(reply[3]);
  return {
    allowed,
    limit: limitOf(spec),
    remaining,
    reset,
    retryAfter,
  };
}

function limitOf(spec: AlgorithmSpec): number {
  switch (spec.kind) {
    case 'token-bucket':
    case 'leaky-bucket':
      return spec.capacity;
    case 'sliding-window-counter':
    case 'sliding-window-log':
    case 'fixed-window':
      return spec.limit;
    default: {
      const exhaustive: never = spec;
      void exhaustive;
      return 0;
    }
  }
}

function isNoScriptError(err: unknown): boolean {
  if (err instanceof Error) {
    return err.message.toUpperCase().includes('NOSCRIPT');
  }
  return false;
}
