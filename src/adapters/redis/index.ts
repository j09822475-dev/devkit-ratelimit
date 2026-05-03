/**
 * Redis store — uses Lua `EVAL` for single-RTT atomic check+decrement.
 * Scripts are loaded with `SCRIPT LOAD` lazily on first use and cached
 * by SHA so subsequent calls go through `EVALSHA`.
 */

import { RateLimitError } from '../../errors/base.js';
import type { AlgorithmSpec, AlgorithmKind } from '../../types/algorithm.js';
import type { RateLimitState } from '../../types/result.js';
import type { ConsumeResult, RateLimitStore } from '../../types/store.js';
import type { RedisLike } from './client.js';
import { LUA_SCRIPTS } from './lua.js';

/**
 * Configuration options for {@link createRedisStore}.
 */
export interface RedisStoreOptions {
  /**
   * Optional prefix prepended to every Redis key by the adapter (in
   * addition to the limiter's `prefix:scope:`). Useful for multi-tenant
   * Redis where every key needs a tenant marker for ACL routing.
   */
  readonly keyPrefix?: string;
}

/**
 * Build a Redis-backed {@link RateLimitStore}.
 *
 * @param client A {@link RedisLike} client (`ioredis`, `redis@^4`, custom).
 * @param opts   Optional adapter-level configuration.
 * @returns      A {@link RateLimitStore}.
 * @example
 *   import Redis from 'ioredis';
 *   const store = createRedisStore(new Redis(process.env.REDIS_URL));
 */
export function createRedisStore(
  client: RedisLike,
  opts: RedisStoreOptions = {},
): RateLimitStore {
  const keyPrefix = opts.keyPrefix ?? '';
  const shaCache = new Map<AlgorithmKind, string>();

  async function evalScript(spec: AlgorithmSpec, key: string, args: (string | number)[]): Promise<unknown> {
    const script = LUA_SCRIPTS[spec.kind];
    let sha = shaCache.get(spec.kind);
    if (sha === undefined && typeof client.scriptLoad === 'function') {
      try {
        sha = await client.scriptLoad(script);
        shaCache.set(spec.kind, sha);
      } catch {
        // Fall through to plain EVAL if SCRIPT LOAD isn't supported.
      }
    }
    if (sha !== undefined) {
      try {
        return await client.evalsha(sha, 1, key, ...args);
      } catch (err) {
        // EVALSHA NOSCRIPT — re-cache and fall back.
        if (isNoScriptError(err)) {
          shaCache.delete(spec.kind);
          return client.eval(script, 1, key, ...args);
        }
        throw err;
      }
    }
    return client.eval(script, 1, key, ...args);
  }

  return {
    name: 'redis',
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
      // The reset is a best-effort wildcard delete. We don't list keys to
      // avoid an O(n) `KEYS` scan; instead we delete the canonical hash
      // / sorted-set / counter at the base key and trust the bucket
      // adapters to share that base.
      const fullKey = keyPrefix + key;
      try {
        // EVAL with a tiny one-liner so we work uniformly across script
        // and non-script clients without adding `del` to the RedisLike
        // interface.
        const reply = await client.eval(
          `return redis.call('DEL', KEYS[1])`,
          1,
          fullKey,
        );
        return Number(reply) > 0;
      } catch (err) {
        if (RateLimitError.is(err)) throw err;
        throw new RateLimitError('STORE_UNAVAILABLE', 'redis: reset failed', err);
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
      `redis: malformed reply (${typeof reply})`,
    );
  }
  // Lua returns numbers as JS numbers via ioredis/redis@4. We coerce
  // defensively in case a custom client returns strings.
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

export type { RedisLike } from './client.js';
