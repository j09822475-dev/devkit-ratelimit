/**
 * Durable Object store — strong consistency within a single object. Each
 * rate-limit key resolves to a single DO instance via
 * `idFromName(prefix:scope:key)`, so all RPCs to that key go to the same
 * isolate and serialise naturally.
 */

import { RateLimitError } from '../../errors/base.js';
import type { AlgorithmSpec } from '../../types/algorithm.js';
import type { RateLimitState } from '../../types/result.js';
import type { ConsumeResult, RateLimitStore } from '../../types/store.js';

/**
 * Minimum DurableObjectNamespace shape the adapter needs. Mirrors the
 * type from `@cloudflare/workers-types`.
 */
export interface DurableObjectNamespaceLike {
  idFromName(name: string): DurableObjectIdLike;
  get(id: DurableObjectIdLike): DurableObjectStubLike;
}

/**
 * Opaque identifier returned by {@link DurableObjectNamespaceLike.idFromName}.
 */
export interface DurableObjectIdLike {
  // Empty by design — the runtime gives us an opaque object.
  readonly __brand?: 'do-id';
}

/**
 * Minimum DurableObjectStub shape — uses the `fetch` method so the
 * reference DO class doesn't need to expose a custom RPC API.
 */
export interface DurableObjectStubLike {
  fetch(input: Request | string): Promise<Response>;
}

/**
 * Configuration options for {@link createDurableObjectStore}.
 */
export interface DurableObjectStoreOptions {
  /** Optional adapter-level prefix. */
  readonly keyPrefix?: string;
}

/**
 * Build a Durable-Object-backed {@link RateLimitStore}. The DO class
 * (`RateLimitDurableObject`) must be re-exported from the worker so
 * Wrangler can bind it.
 *
 * @param namespace A DO namespace binding (`env.RATELIMIT_DO`).
 * @param opts      Optional configuration.
 * @returns         A {@link RateLimitStore}.
 */
export function createDurableObjectStore(
  namespace: DurableObjectNamespaceLike,
  opts: DurableObjectStoreOptions = {},
): RateLimitStore {
  const keyPrefix = opts.keyPrefix ?? '';

  function getStub(key: string): DurableObjectStubLike {
    const id = namespace.idFromName(keyPrefix + key);
    return namespace.get(id);
  }

  async function rpc(
    op: 'consume' | 'peek' | 'reset',
    key: string,
    spec: AlgorithmSpec | undefined,
    cost: number | undefined,
    now: number | undefined,
  ): Promise<unknown> {
    const stub = getStub(key);
    try {
      const res = await stub.fetch(
        new Request('https://do/rpc', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ op, key, spec, cost, now }),
        }),
      );
      if (!res.ok) {
        throw new RateLimitError(
          'STORE_UNAVAILABLE',
          `do: rpc returned ${res.status}`,
        );
      }
      return await res.json();
    } catch (err) {
      if (RateLimitError.is(err)) throw err;
      throw new RateLimitError('STORE_UNAVAILABLE', 'do: rpc failed', err);
    }
  }

  return {
    name: 'do',
    async consume(key, spec, cost, now): Promise<ConsumeResult> {
      const reply = (await rpc('consume', key, spec, cost, now)) as ConsumeResult;
      return reply;
    },
    async peek(key, spec, now): Promise<RateLimitState> {
      const reply = (await rpc('peek', key, spec, undefined, now)) as ConsumeResult;
      return {
        limit: reply.limit,
        remaining: reply.remaining,
        reset: reply.reset,
        retryAfter: reply.retryAfter,
      };
    },
    async reset(key): Promise<boolean> {
      const reply = (await rpc('reset', key, undefined, undefined, undefined)) as {
        existed: boolean;
      };
      return reply.existed;
    },
  };
}

export { RateLimitDurableObject } from './ratelimit-do.js';
