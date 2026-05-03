/**
 * Configuration types for `createRateLimiter`.
 */

import type { AlgorithmSpec } from './algorithm.js';
import type { HeaderStyle } from './headers.js';
import type { KeyGenerator } from './key.js';
import type { RateLimitHook } from './observability.js';
import type { RateLimitResult } from './result.js';
import type { RateLimitStore } from './store.js';
import type { Duration } from './runtime.js';

/**
 * How the observability hook is invoked.
 *
 * - `'fire-and-forget'` (default) — scheduled via `queueMicrotask`, never
 *   awaited. The right default on edge runtimes where `executionCtx` is
 *   not directly available.
 * - `'sync'` — awaited inline, bounded by `hookTimeoutMs`. Useful for
 *   tests that need to assert observation order.
 * - `'wait-until'` — opt-in for framework adapters that own
 *   `executionCtx.waitUntil`. The adapter MUST set this explicitly.
 */
export type HookMode = 'fire-and-forget' | 'sync' | 'wait-until';

/**
 * Spec-form configuration accepted by `createRateLimiter`. The
 * `algorithm` is a branded {@link AlgorithmSpec} produced by one of the
 * factory subpaths (`slidingWindow()`, `tokenBucket()`, …).
 *
 * @typeParam K Caller-defined context payload type.
 */
export interface RateLimitConfig<K = undefined> {
  /**
   * The rate-limit policy — produced by one of the algorithm factories.
   * The core engine never inspects fields beyond `kind`; everything else
   * is passed to the store as opaque parameters of the dispatch.
   */
  readonly algorithm: AlgorithmSpec;

  /**
   * Storage adapter. **Required** — there is no default. Consumers
   * wanting a dev/test in-memory store must explicitly import
   * `createMemoryStore` from `@devkit/ratelimit/adapters/memory`.
   */
  readonly store: RateLimitStore;

  /**
   * Extract the bucketing key for a request. Defaults to
   * {@link defaultKeyGenerator}, which inspects `cf-connecting-ip`,
   * `x-real-ip`, `x-forwarded-for` (first hop). Returning `null` /
   * `undefined` / `''` skips rate limiting for the request.
   */
  readonly keyGenerator?: KeyGenerator<K>;

  /**
   * Prefix prepended to every store key. Defaults to `'rl'`. Empty
   * string is allowed for advanced users.
   */
  readonly prefix?: string;

  /**
   * Logical scope appended after `prefix` and before the user key.
   * Defaults to a stable hash of the algorithm spec, so two limiters
   * with the same prefix but different policies cannot collide.
   */
  readonly scope?: string;

  /**
   * Header style on `result.headers`. Default `'rfc'`.
   */
  readonly headerStyle?: HeaderStyle;

  /**
   * Build the 429 response when `middleware()` short-circuits. Defaults
   * to a `text/plain` body that reads the configured `message`.
   */
  readonly responseBuilder?: (
    info: RateLimitResult<K> & { req: Request },
  ) => Response | Promise<Response>;

  /**
   * Plain-text body for the default 429 response. Default
   * `'Too Many Requests'`. Ignored when `responseBuilder` is supplied.
   */
  readonly message?: string;

  /**
   * Fail-closed (`false`, default) propagates `STORE_UNAVAILABLE` to the
   * caller. Fail-open (`true`) swallows infrastructure errors and
   * returns `{ allowed: true, degraded: true }`.
   */
  readonly failOpen?: boolean;

  /**
   * Default cost per `check()` call. Overridable via
   * `check(req, { cost: 5 })`. MUST be a positive finite number.
   */
  readonly cost?: number;

  /**
   * Observability hook. See `hookMode` for execution semantics.
   */
  readonly on?: RateLimitHook<K>;

  /**
   * Hook execution mode. Default `'fire-and-forget'`.
   */
  readonly hookMode?: HookMode;

  /** Bound on `'sync'` hook duration. Ignored otherwise. Default 50 ms. */
  readonly hookTimeoutMs?: number;

  /**
   * Override the wall clock. Defaults to `() => Date.now()`. Useful for
   * deterministic tests and for runtimes with `Date.now()` quirks.
   */
  readonly clock?: () => number;

  /**
   * Maximum allowed length of a generated key. Default 1024. Over the
   * limit produces `KEY_TOO_LONG`. Stores have hard limits (KV: 512 B,
   * Redis: 512 MB but realistically &lt;1 KB for cache hit rate).
   */
  readonly maxKeyLength?: number;

  /**
   * Optional executionCtx wired by framework adapters that detect a
   * Cloudflare/Vercel binding. The core never reads it directly except
   * in the `'wait-until'` hookMode.
   */
  readonly executionCtx?: { waitUntil(p: Promise<unknown>): void };
}

/**
 * Sugar-form (flat) configuration. The `algorithm` is a string literal
 * and the algorithm's tuning fields are inline. The core inlines a small
 * normaliser table to brand these into {@link AlgorithmSpec} variants.
 *
 * @typeParam K Caller-defined context payload type.
 */
export type RateLimitFlatConfig<K = undefined> =
  & Omit<RateLimitConfig<K>, 'algorithm'>
  & (
    | { algorithm: 'sliding-window'; limit: number; window: Duration }
    | { algorithm: 'sliding-window-log'; limit: number; window: Duration }
    | { algorithm: 'fixed-window'; limit: number; window: Duration }
    | { algorithm: 'token-bucket'; capacity: number; refill: number; interval: Duration }
    | { algorithm: 'leaky-bucket'; capacity: number; leak: number; interval: Duration }
  );

/**
 * The fully-normalised, frozen view of a {@link RateLimitConfig} that the
 * limiter handle exposes via `limiter.config`. Defaults are baked in.
 *
 * @typeParam K Caller-defined context payload type.
 */
export interface NormalisedRateLimitConfig<K = undefined> {
  readonly algorithm: AlgorithmSpec;
  readonly store: RateLimitStore;
  readonly keyGenerator: KeyGenerator<K>;
  readonly prefix: string;
  readonly scope: string;
  readonly headerStyle: HeaderStyle;
  readonly responseBuilder: (
    info: RateLimitResult<K> & { req: Request },
  ) => Response | Promise<Response>;
  readonly message: string;
  readonly failOpen: boolean;
  readonly cost: number;
  readonly on: RateLimitHook<K> | undefined;
  readonly hookMode: HookMode;
  readonly hookTimeoutMs: number;
  readonly clock: () => number;
  readonly maxKeyLength: number;
  readonly executionCtx: { waitUntil(p: Promise<unknown>): void } | undefined;
}
