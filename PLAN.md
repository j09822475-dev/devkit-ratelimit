# `@devkit/ratelimit` — Architecture Plan

> Universal, **zero-dependency**, **edge-runtime-native** rate limiter built
> on the Web Standard `Request` / `Response` API. The core engine targets
> **≤6 KB gzipped**; every storage adapter and framework adapter lives behind
> its own subpath export and is only pulled in when the consumer imports it,
> so a Cloudflare Workers build using `memory` + `sliding-window` ships
> ~3.5 KB total. Runs unmodified in **Node 20+, Bun 1.0+, Deno 1.40+,
> Cloudflare Workers, Vercel Edge, Netlify Edge** — and in the browser, for
> client-side throttling — through Web Standards (`Request`, `Response`,
> `Headers`, `Date.now`).
>
> Five algorithms (sliding-window log, sliding-window counter, token bucket,
> fixed window, leaky bucket), six storage adapters (memory, Redis,
> Upstash REST, Cloudflare KV, Cloudflare D1, Durable Objects), six framework
> adapters (Hono, Elysia, Express, Fastify, Next.js, SvelteKit). RFC-draft
> `RateLimit-Policy` + `RateLimit` response headers (IETF
> `draft-ietf-httpapi-ratelimit-headers-10`) plus optional legacy
> `X-RateLimit-*` for clients that still expect them.
>
> Positioned to **fill the gap left by the framework-locked status quo** —
> `express-rate-limit` is Express-only, `rate-limiter-flexible` uses
> Node-specific APIs and does not run on Workers/Deno/Bun, `@upstash/ratelimit`
> requires a paid Upstash Redis account, `bottleneck` has been in maintenance
> mode since 2020, and `hono-rate-limiter` is bound to Hono's `Context`. We
> compete on **runtime portability + adapter neutrality + bundle size**.
> Source of truth for the market problem statement is
> `reports/08-rate-limiter-universal.json` (id `08`, dated 2026-04-27).

---

## Table of Contents

1. [Project Structure](#1-project-structure)
2. [Public API Design](#2-public-api-design)
3. [Internal Architecture](#3-internal-architecture)
4. [Type System](#4-type-system)
5. [Error Handling Strategy](#5-error-handling-strategy)
6. [Bundle & Tree-shaking Plan](#6-bundle--tree-shaking-plan)
7. [Dependencies](#7-dependencies)
8. [Configuration](#8-configuration)
9. [Edge Cases](#9-edge-cases)
10. [Out of Scope (1.0)](#10-out-of-scope-10)

---

## 1. Project Structure

Every file in `src/` is single-purpose; no file imports from `dist/`, no file
imports through a sibling `index.ts` re-export (re-exports happen only at
**package boundaries** — files referenced from `package.json#exports`). This
keeps the dependency graph **acyclic**, side-effect-free and aggressively
tree-shakeable: a consumer who imports only `@devkit/ratelimit/adapters/memory`
and `@devkit/ratelimit/algorithms/sliding-window` does not pull in any other
algorithm, store, framework adapter, or even the `headers` formatter for the
non-default header style.

```
devkit-ratelimit/
├── PLAN.md                          # this document
├── README.md                        # 5-min getting started + API reference
├── LICENSE                          # MIT
├── CHANGELOG.md                     # changesets-managed
├── package.json                     # see §8
├── tsconfig.json                    # strict, ES2024, NodeNext, declaration
├── tsconfig.build.json              # build-only overrides (excludes test/)
├── tsup.config.ts                   # multi-entry esm+dts bundler
├── vitest.config.ts                 # node + workers pool workspace
├── biome.json                       # lint + format (replaces eslint+prettier)
├── .size-limit.json                 # per-entry budget (CI gate)
├── .gitignore                       # see §8.4
├── .npmignore                       # narrows publish to dist/ + LICENSE/README
├── .changeset/
│   └── config.json
├── .github/
│   └── workflows/
│       ├── ci.yml                   # test + typecheck + size-limit + attw + publint
│       └── release.yml              # changesets publish on main
│
├── src/
│   ├── index.ts                     # core public entrypoint
│   │                                # re-exports createRateLimiter, default
│   │                                # algorithm factories, RateLimitError,
│   │                                # type helpers — nothing else
│   │
│   ├── core/
│   │   ├── limiter.ts               # createRateLimiter() — central factory
│   │   │                            # - composes algorithm + store + key + headers
│   │   │                            # - returns frozen RateLimiter handle
│   │   ├── consume.ts               # the single "atomic consume" pipeline
│   │   │                            # - normalises the result for any algorithm
│   │   ├── headers.ts               # buildHeaders(state, style) — RFC + legacy
│   │   │                            # - the only file that mints response Headers
│   │   ├── response.ts               # build429Response(state, opts) — default
│   │   │                            # 429 builder; user can override
│   │   ├── duration.ts              # parseDuration('1m' | 60_000) → ms
│   │   │                            # - shared by every algorithm factory
│   │   ├── time.ts                  # nowMs() — single time source for tests
│   │   ├── key.ts                   # composeKey(prefix, scope, key) +
│   │   │                            #   defaultKeyGenerator (CF/Vercel-aware)
│   │   ├── invariant.ts             # invariant(cond, code, msg) → RateLimitError
│   │   ├── algorithm-spec.ts        # AlgorithmSpec discriminated union (data)
│   │   │                            # - core has zero static knowledge of any
│   │   │                            #   algorithm logic; only the spec shape
│   │   └── store-contract.ts        # RateLimitStore<S> interface (type-only)
│   │
│   ├── algorithms/                  # opt-in algorithm subpath modules
│   │   ├── sliding-window/
│   │   │   └── index.ts             # slidingWindow() — the precise log variant
│   │   │                            # is `slidingWindowLog`; this default uses
│   │   │                            # the counter approximation (cheaper).
│   │   ├── sliding-window-log/
│   │   │   └── index.ts             # slidingWindowLog() — sorted-set based
│   │   │                            # exact algorithm; opt-in for billing-grade
│   │   │                            # accuracy at higher memory cost.
│   │   ├── token-bucket/
│   │   │   └── index.ts             # tokenBucket() — refill + capacity
│   │   ├── fixed-window/
│   │   │   └── index.ts             # fixedWindow() — atomic INCR + EXPIRE
│   │   └── leaky-bucket/
│   │       └── index.ts             # leakyBucket() — egress smoother
│   │
│   ├── adapters/
│   │   ├── memory/
│   │   │   └── index.ts             # createMemoryStore({ maxSize? }) — Map-backed
│   │   │                            # LRU; honours every algorithm spec via
│   │   │                            # an in-process atomic dispatch (no async
│   │   │                            # interleave possible in single-threaded JS).
│   │   ├── redis/
│   │   │   ├── index.ts             # createRedisStore(client, opts)
│   │   │   ├── client.ts            # RedisLike narrow interface
│   │   │   │                        # { eval, evalsha, scriptLoad, get, set,
│   │   │   │                        #   incr, expire, zadd, zcount, zremrangebyscore }
│   │   │   └── lua.ts               # Lua scripts per algorithm (sliding window
│   │   │                            #   counter, sliding window log, token bucket,
│   │   │                            #   fixed window, leaky bucket) — single-RTT
│   │   │                            #   atomic check+decrement.
│   │   ├── upstash/
│   │   │   ├── index.ts             # createUpstashStore(redis) — uses HTTP
│   │   │   │                        # `eval` (Upstash supports server-side scripts).
│   │   │   └── lua.ts               # re-imports the same scripts from
│   │   │                            #   ../redis/lua.ts (one source of truth).
│   │   ├── cloudflare-kv/
│   │   │   └── index.ts             # createKVStore(KVNamespace, opts) —
│   │   │                            #   eventually consistent, best-effort.
│   │   ├── cloudflare-d1/
│   │   │   ├── index.ts             # createD1Store(D1Database) — single-statement
│   │   │   │                        #   `WITH inserted AS (...) UPDATE ... RETURNING`
│   │   │   │                        #   atomic CTE per algorithm.
│   │   │   └── schema.sql           # DDL for ratelimit table + (key, ts) idx
│   │   └── durable-object/
│   │       ├── index.ts             # createDurableObjectStore(stub) — strong
│   │       │                        #   consistency reference impl.
│   │       └── ratelimit-do.ts      # Reference Durable Object class users can
│   │                                # either re-export or subclass.
│   │
│   ├── frameworks/
│   │   ├── hono/
│   │   │   └── index.ts             # honoRateLimit(limiter) middleware
│   │   ├── elysia/
│   │   │   └── index.ts             # elysiaRateLimit(limiter) plugin
│   │   ├── express/
│   │   │   └── index.ts             # expressRateLimit(limiter) — adapts
│   │   │                            # (req,res,next) to a Web-Standard Request
│   │   │                            # via @standard-schema-style shim
│   │   ├── fastify/
│   │   │   └── index.ts             # fastifyRateLimit(limiter) fastify-plugin
│   │   ├── next/
│   │   │   ├── index.ts             # withRateLimit() — Route Handler wrapper
│   │   │   └── middleware.ts        # rateLimitMiddleware() — Next middleware
│   │   └── sveltekit/
│   │       └── index.ts             # rateLimitHandle(limiter) SvelteKit handle
│   │
│   ├── compose/
│   │   ├── index.ts                 # subpath barrel — composeAll,
│   │   │                            # composeFirstAllowed, tieredRateLimiter,
│   │   │                            # ruledRateLimiter
│   │   ├── all.ts                   # composeAll([a, b]) — logical AND;
│   │   │                            #   first-to-block wins, prior layers
│   │   │                            #   have already consumed
│   │   ├── first-allowed.ts         # composeFirstAllowed([a, b]) — logical
│   │   │                            #   OR; short-circuits without consuming
│   │   │                            #   subsequent layers
│   │   ├── tiered.ts                # tieredRateLimiter({ free, pro, ... })
│   │   └── ruled.ts                 # ruledRateLimiter({ rules, fallback })
│   │
│   ├── errors/
│   │   ├── index.ts                 # errors subpath barrel
│   │   ├── base.ts                  # RateLimitError extends Error + .is() guard
│   │   └── codes.ts                 # RATELIMIT_ERROR_CODES const + type
│   │
│   ├── types/
│   │   ├── index.ts                 # type-only public surface, no runtime
│   │   ├── result.ts                # RateLimitResult, RateLimitState
│   │   ├── algorithm.ts              # AlgorithmSpec discriminated union
│   │   ├── store.ts                 # RateLimitStore + per-algorithm op types
│   │   ├── limiter.ts               # RateLimiter, RateLimiterMiddleware
│   │   ├── config.ts                # RateLimitConfig + nested options
│   │   ├── headers.ts               # HeaderStyle, HeaderBuilder
│   │   ├── key.ts                   # KeyGenerator, KeyGeneratorContext
│   │   ├── observability.ts         # RateLimitHook, RateLimitObservation
│   │   └── runtime.ts               # MinimalRequest shim for non-fetch callers
│   │
│   └── utils/
│       ├── env.ts                   # isDev() — single portable runtime probe
│       │                            # (banned via Biome rule from being inlined
│       │                            #  anywhere else for Workers/Deno safety)
│       ├── base64url.ts             # base64url encode/decode (used by key hashing)
│       ├── hash.ts                  # FNV-1a 64-bit + djb2 (32-bit) for key
│       │                            #   compaction; no crypto-strength needed.
│       └── lru.ts                   # tiny doubly-linked LRU used by memory store
│
├── test/
│   ├── core/
│   │   ├── limiter.test.ts          # full check/reset/peek matrix
│   │   ├── headers.test.ts          # RFC + legacy header byte parity
│   │   ├── duration.test.ts         # '1s' | 1000 | '5m' parser + bounds
│   │   ├── key.test.ts              # default key extractor + CF/Vercel headers
│   │   └── consume.test.ts          # state normalisation + cost > capacity
│   ├── algorithms/
│   │   ├── sliding-window.test.ts   # counter approximation accuracy
│   │   ├── sliding-window-log.test.ts # exact bound on a synthetic stream
│   │   ├── token-bucket.test.ts     # refill timing, burst, clock skew
│   │   ├── fixed-window.test.ts     # boundary 2x burst, INCR atomicity
│   │   └── leaky-bucket.test.ts     # leak rate + queue overflow
│   ├── adapters/
│   │   ├── memory.test.ts
│   │   ├── redis.test.ts            # ioredis-mock + real Redis via testcontainers
│   │   ├── upstash.test.ts          # MSW HTTP fixture + REST script semantics
│   │   ├── kv.test.ts               # miniflare KVNamespace
│   │   ├── d1.test.ts               # miniflare D1
│   │   └── durable-object.test.ts   # miniflare DO
│   ├── frameworks/
│   │   ├── hono.test.ts
│   │   ├── elysia.test.ts
│   │   ├── express.test.ts          # supertest
│   │   ├── fastify.test.ts          # fastify.inject
│   │   ├── next.test.ts             # NextRequest mock
│   │   └── sveltekit.test.ts
│   ├── compose/
│   │   ├── any-of.test.ts           # first-match-blocks semantics
│   │   ├── tiered.test.ts           # tier resolver + limit selection
│   │   └── ruled.test.ts            # rule order + fallback
│   ├── runtime/
│   │   ├── workers.test.ts          # @cloudflare/vitest-pool-workers
│   │   └── edge.test.ts             # globalThis.process undefined check
│   ├── types/
│   │   └── inference.test-d.ts      # vitest --typecheck (generic propagation)
│   ├── correctness/
│   │   ├── concurrency.test.ts      # N parallel requests stay within limit
│   │   ├── clock-skew.test.ts       # ±60 s tolerance
│   │   ├── boundary-fairness.test.ts # fixed-window 2x burst confirmation
│   │   └── header-rfc.test.ts       # draft-ietf-httpapi-ratelimit-headers-10
│   └── bench/
│       └── limiter.bench.ts         # vitest bench — check() per RPS
│
└── examples/                        # not published — referenced from README
    ├── hono-cloudflare-kv/
    ├── nextjs-redis/
    ├── sveltekit-postgres/          # via raw query interface
    ├── express-redis/
    └── deno-deploy/
```

---

## 2. Public API Design

This section is the complete TypeScript surface — everything the consumer can
import. Anything **not** listed here is **internal**, may break in a patch
release, and is tagged `@internal` in TSDoc so `api-extractor` strips it from
the published `.d.ts` rollup.

### 2.1 Root entrypoint — `@devkit/ratelimit`

```ts
/**
 * Create a rate limiter bound to a single algorithm + storage backend. The
 * returned handle is `Object.freeze`d and safe to share across requests in
 * the same runtime instance.
 *
 * The limiter is **runtime-agnostic**: it accepts a Web-Standard `Request`
 * and returns a `RateLimitResult` that carries everything needed to either
 * continue handling or short-circuit with a `429`. The same code runs in
 * Node 20+, Bun, Deno, Cloudflare Workers, Vercel Edge and the browser
 * (for client-side throttling).
 *
 * Two construction forms — both produce an identical `RateLimiter`:
 *
 *   1. **Spec form** (best tree-shake, recommended for size-sensitive
 *      builds): import the algorithm factory from its subpath and pass
 *      its result as `algorithm`. The core engine ships **zero**
 *      algorithm code in this path; only the imported factory's bytes
 *      land in the bundle.
 *
 *   2. **Flat / sugar form** (fewer imports, ~0.2 KB heavier core):
 *      pass a string `algorithm` discriminator with the algorithm's
 *      tuning fields inline. The core inlines a tiny dispatch table
 *      (~150 B) over the five algorithms' spec normalisers; consumers
 *      never need to import a subpath. Recommended for getting started,
 *      docs and screenshot-friendly snippets. The five algorithm
 *      subpaths remain available for users who want the bundle minimum.
 *
 * @typeParam K  Optional context payload threaded through
 *               `keyGenerator` → `RateLimitResult<K>` → framework
 *               adapters (so e.g. Hono's `c.var.rateLimit.context` is
 *               typed end-to-end). Defaults to `undefined`; supply it
 *               only when your `keyGenerator` returns a structured
 *               object via `{ key, context }` and you want downstream
 *               handlers to read `context` typed.
 *
 * @example  Sugar form — minimal imports
 *   import { createRateLimiter } from '@devkit/ratelimit';
 *   import { createRedisStore } from '@devkit/ratelimit/adapters/redis';
 *
 *   const limiter = createRateLimiter({
 *     algorithm: 'sliding-window',
 *     limit: 100,
 *     window: '1 m',
 *     store: createRedisStore(redis),
 *   });
 *
 * @example  Spec form — minimum bundle
 *   import { createRateLimiter } from '@devkit/ratelimit';
 *   import { slidingWindow } from '@devkit/ratelimit/algorithms/sliding-window';
 *   import { createRedisStore } from '@devkit/ratelimit/adapters/redis';
 *
 *   const limiter = createRateLimiter({
 *     algorithm: slidingWindow({ limit: 100, window: '1 m' }),
 *     store: createRedisStore(redis),
 *     keyGenerator: (req) => req.headers.get('x-api-key') ?? defaultKey(req),
 *   });
 *
 *   // Inside a Web-Standard fetch handler:
 *   const result = await limiter.check(req);
 *   if (!result.allowed) {
 *     return new Response('rate limited', { status: 429, headers: result.headers });
 *   }
 *   // ...continue, optionally merging `result.headers` into the response.
 */
export function createRateLimiter<K = undefined>(
  config: RateLimitConfig<K>,
): RateLimiter<K>;
export function createRateLimiter<K = undefined>(
  config: RateLimitFlatConfig<K>,
): RateLimiter<K>;

/**
 * Flat-form configuration accepted by the sugar overload. The core engine
 * inlines normalisation + bounds checks for each `algorithm` discriminator
 * (~150 B total) so consumers do not need to import an algorithm subpath.
 * The exported union is a discriminated type, so TypeScript narrows the
 * required tuning fields based on the `algorithm` literal.
 */
export type RateLimitFlatConfig<K = undefined> = Omit<RateLimitConfig<K>, 'algorithm'> & (
  | { algorithm: 'sliding-window';     limit: number;    window: Duration }
  | { algorithm: 'sliding-window-log'; limit: number;    window: Duration }
  | { algorithm: 'fixed-window';       limit: number;    window: Duration }
  | { algorithm: 'token-bucket';       capacity: number; refill: number; interval: Duration }
  | { algorithm: 'leaky-bucket';       capacity: number; leak: number;   interval: Duration }
);

export { RateLimitError } from './errors/index.js';
export { defaultKeyGenerator, composeKey } from './core/key.js';
export { parseDuration } from './core/duration.js';
export type {
  RateLimitConfig,
  RateLimitFlatConfig,
  RateLimiter,
  RateLimiterMiddleware,
  RateLimitResult,
  RateLimitState,
  RateLimitStore,
  AlgorithmSpec,
  KeyGenerator,
  KeyGeneratorContext,
  HeaderStyle,
  HeaderBuilder,
  RateLimitHook,
  RateLimitObservation,
  Duration,
} from './types/index.js';
```

The five algorithm factories also live behind their own subpaths
(`@devkit/ratelimit/algorithms/sliding-window` etc.). The core engine
**dispatches purely on the `AlgorithmSpec.kind` discriminator** — there is
no per-algorithm logic in `core/*` beyond the unit-normalisation table the
sugar overload uses. A spec-form build that imports only `slidingWindow()`
ships **none** of the other four algorithms' code paths; a sugar-form
build pays ~0.2 KB extra core for the inlined dispatch (over all five
algorithms' normalisers, which are 30–40 LOC each).

Why subpaths and not a single `algorithms` barrel: every algorithm carries
its own spec validation (`window` bounds check, `capacity > 0`, etc.) and
helpers. Barrelling them costs ~1.5 KB to a consumer who picked one. The
subpath split is purely a **bundle-size lever**; the runtime contract is
identical between sugar and spec forms.

### 2.2 Result + state shape

```ts
/**
 * The outcome of a single `limiter.check(req)` call. `headers` is a fresh
 * `Headers` object pre-filled per the configured `headerStyle` so the
 * caller can either:
 *
 *   1. Pass it as `new Response(body, { status: 429, headers: result.headers })`
 *      when blocked, or
 *   2. Merge it into the success response so clients see the live policy.
 *
 * `state` is the raw, header-style-independent view of the limit; consumers
 * building dashboards or custom transports read from there.
 *
 * @typeParam K  Optional context payload threaded from `keyGenerator`. When
 *               unused (the default), `context` is `undefined` and consumers
 *               can ignore it; framework adapters that accept a generic
 *               `RateLimiter<K>` propagate this to handlers (e.g.
 *               `c.var.rateLimit.context` is typed as `K` in Hono).
 */
export interface RateLimitResult<K = undefined> {
  /** `true` when the request is permitted; `false` when over the limit. */
  readonly allowed: boolean;
  /** The opaque key the request was bucketed against. Useful for logs. */
  readonly key: string;
  /** Live state — the same numbers serialised into `headers`. */
  readonly state: RateLimitState;
  /** Pre-filled response headers per the configured `headerStyle`. */
  readonly headers: Headers;
  /**
   * `true` when the result was produced under fail-open degradation —
   * either the store was unavailable (`failOpen: true` swallowed the
   * error) or `peek()` returned a stale last-known state because the
   * store was unreachable. Consumers building quota-display widgets can
   * use this to render "approximate" badges.
   */
  readonly degraded: boolean;
  /**
   * Caller-defined context returned by the `keyGenerator` alongside the
   * key (when the structured `{ key, context }` form is used). Typed as
   * `K`; `undefined` when the key generator returned a bare string.
   */
  readonly context: K;
}

export interface RateLimitState {
  /** Configured maximum permitted within the window / bucket. */
  readonly limit: number;
  /** Permits remaining at the moment of the check (clamped to ≥0). */
  readonly remaining: number;
  /**
   * Unix milliseconds at which the *next* permit becomes available, OR the
   * fixed window resets — whichever is sooner. For `sliding-window-counter`
   * and `sliding-window-log` this is the moment the oldest event leaves
   * the window. For `token-bucket` / `leaky-bucket` it's the next refill /
   * leak tick that frees a slot.
   */
  readonly reset: number;
  /**
   * Milliseconds to wait before the next permit is available. `0` when
   * `allowed === true`. Used to populate the `Retry-After` header on 429
   * responses (rounded **up** to the next whole second per RFC 9110).
   */
  readonly retryAfter: number;
}
```

### 2.3 Limiter handle

```ts
export interface RateLimiter<K = undefined> {
  /**
   * Atomically consume one (or `cost`) permit(s) for the request's key.
   * Never throws on a missing/invalid key when `keyGenerator` returned a
   * non-empty string. Throws `RateLimitError('STORE_UNAVAILABLE')` when
   * the underlying store is unreachable **and** `failOpen` is `false`
   * (the default); when `failOpen: true`, the manager emits
   * `'rate-limit.error'` via the observability hook, returns
   * `{ allowed: true, degraded: true }`, and stamps the configured
   * `headerStyle` headers from the **last-known** policy (the policy is
   * still advertised even when we couldn't measure it).
   */
  check(req: Request, opts?: { cost?: number }): Promise<RateLimitResult<K>>;

  /**
   * Inspect the current state for a request without consuming a permit.
   * Useful for surfacing live quota in API responses without double-charging.
   *
   * Honours `failOpen` exactly the same way `check()` does — when the
   * store is unreachable and `failOpen: true`, peek resolves with
   * `{ allowed: true, degraded: true }` carrying the **last-known**
   * state (zero values when no prior observation exists for the key).
   * When `failOpen: false` (default), peek throws `STORE_UNAVAILABLE`
   * just like `check()`. This symmetry matters for quota-display widgets
   * that consult the limiter on every page render and would otherwise
   * surface infrastructure flapping as user-facing 5xx.
   */
  peek(req: Request): Promise<RateLimitResult<K>>;

  /**
   * Reset the counter for the request's key. Used by admin tooling
   * ("clear ban") and tests. Returns `true` iff something existed.
   */
  reset(req: Request): Promise<boolean>;

  /** Reset by an explicit key — for jobs that don't have a `Request`. */
  resetKey(key: string): Promise<boolean>;

  /**
   * Return a Web-Standard middleware: `(req: Request) => Promise<Response | undefined>`.
   * Resolves to a 429 `Response` when blocked (built via the configured
   * `responseBuilder`); resolves to `undefined` when allowed, in which case
   * the caller continues and the limiter will have already enriched
   * subsequent responses through `attach(headers, result)` (see §2.5).
   *
   * @example
   *   const middleware = limiter.middleware();
   *   export default {
   *     async fetch(req: Request, env: Env) {
   *       const blocked = await middleware(req);
   *       if (blocked) return blocked;
   *       return new Response('ok');
   *     },
   *   };
   */
  middleware(): RateLimiterMiddleware;

  /**
   * The frozen, normalised configuration the limiter was constructed with —
   * exposed for observability and for framework adapters that need to
   * surface `algorithm.kind`, `prefix`, etc. on their context.
   */
  readonly config: Readonly<NormalisedRateLimitConfig<K>>;
}

export type RateLimiterMiddleware = (req: Request) => Promise<Response | undefined>;
```

### 2.4 Algorithm factories (subpath imports)

Each algorithm factory returns an `AlgorithmSpec` — a plain data object that
the store consumes. The factory is the one place where unit normalisation
(`'1m' → 60_000 ms`), bounds checking and platform-specific guards live.

```ts
// @devkit/ratelimit/algorithms/sliding-window
/**
 * Sliding-window **counter** algorithm — approximates a true sliding window
 * by interpolating between two adjacent fixed windows. ~1 % overshoot worst
 * case; cost is two integer counters per key per window. The right default
 * for 99 % of API rate limiting (dramatically cheaper than the log variant
 * with comparable practical accuracy).
 *
 * @param limit  Maximum number of permits per `window`. MUST be a positive
 *               finite integer.
 * @param window Window length — accepts the `Duration` union (`'1 m'`,
 *               `60_000`, `{ minutes: 1 }`). Must resolve to ≥ 1 ms and
 *               ≤ the lowest store TTL ceiling (49.7 days for Redis EXPIRE,
 *               documented per adapter).
 *
 * @example slidingWindow({ limit: 100, window: '1 m' })
 */
export function slidingWindow(opts: {
  limit: number;
  window: Duration;
}): AlgorithmSpec & { kind: 'sliding-window-counter' };

// @devkit/ratelimit/algorithms/sliding-window-log
/**
 * Sliding-window **log** algorithm — exact bound, no approximation. Stores
 * a sorted set of event timestamps per key and counts those within the
 * window on each check. Memory cost is O(limit) per key vs the counter's
 * O(1); pick this when accuracy matters more than memory (billing-critical,
 * compliance-driven quotas).
 */
export function slidingWindowLog(opts: {
  limit: number;
  window: Duration;
}): AlgorithmSpec & { kind: 'sliding-window-log' };

// @devkit/ratelimit/algorithms/token-bucket
/**
 * Token bucket — capacity tokens, refilled at `refill` per `interval`. The
 * canonical "burst-friendly" algorithm: a client can spend `capacity` tokens
 * immediately, then is throttled to the steady refill rate. Ideal for
 * AI/LLM endpoints where you want to amortise expensive calls but cap
 * sustained throughput.
 *
 * @param capacity   Bucket size — the maximum burst (must be ≥ refill).
 * @param refill     Tokens added per `interval`. Must be a positive number.
 * @param interval   Refill cadence; resolves to ms. Refill is computed
 *                   continuously (`(elapsed / interval) * refill`) so the
 *                   choice of interval is presentational, not behavioural.
 */
export function tokenBucket(opts: {
  capacity: number;
  refill: number;
  interval: Duration;
}): AlgorithmSpec & { kind: 'token-bucket' };

// @devkit/ratelimit/algorithms/fixed-window
/**
 * Fixed window — N permits per aligned wall-clock window (e.g. per minute,
 * per hour). Cheapest to implement (a single atomic INCR + EXPIRE in
 * Redis) but allows up to **2N** requests across a window boundary in
 * the worst case. Use only when that property is acceptable.
 */
export function fixedWindow(opts: {
  limit: number;
  window: Duration;
}): AlgorithmSpec & { kind: 'fixed-window' };

// @devkit/ratelimit/algorithms/leaky-bucket
/**
 * Leaky bucket — capacity slots, drained at `leak` per `interval`. Smooths
 * outbound traffic to a constant rate (good for webhook delivery, third-party
 * API quotas). Differs from token bucket in that bursts are **queued**
 * conceptually rather than admitted at full speed.
 */
export function leakyBucket(opts: {
  capacity: number;
  leak: number;
  interval: Duration;
}): AlgorithmSpec & { kind: 'leaky-bucket' };
```

### 2.5 Configuration

```ts
export interface RateLimitConfig<K = undefined> {
  /**
   * The rate-limit policy — produced by one of the algorithm factories
   * (spec form). The sugar overload accepts a `RateLimitFlatConfig`
   * instead, where `algorithm` is a string discriminator and the tuning
   * fields are inline. The core engine **never** inspects fields beyond
   * `kind`; everything else is passed to the store as opaque parameters
   * of the dispatch.
   */
  algorithm: AlgorithmSpec;

  /**
   * Storage adapter. **Required** — there is no default. The TypeScript
   * compiler forces the choice; consumers wanting a dev/test in-memory
   * store must explicitly
   * `import { createMemoryStore } from '@devkit/ratelimit/adapters/memory'`.
   * This avoids the rate-limiter-flexible footgun where an unconfigured
   * production deployment silently accumulates state in a leaky `Map`
   * across worker restarts (or worse, leaks per-isolate on Workers).
   */
  store: RateLimitStore;

  /**
   * Extract the key the request is bucketed against. Receives the
   * `Request` plus a small context object carrying any framework-supplied
   * fields (Cloudflare `cf.connectingIp`, Vercel `request.geo`, etc.).
   *
   * May return either:
   *   - a **bare string** (the key), or `null` / `undefined` / `''` to
   *     skip rate limiting (the limiter emits `rate-limit.skipped` via
   *     the observability hook), or
   *   - a **structured `{ key, context }`** object, where `context` is
   *     the typed payload that flows through `RateLimitResult<K>` to
   *     framework adapters and downstream handlers (e.g.
   *     `c.var.rateLimit.context` in the Hono adapter).
   *
   * Default (when omitted): `defaultKeyGenerator`, which inspects
   * `cf-connecting-ip`, `x-real-ip`, `x-forwarded-for` (first hop),
   * then `request.headers.get('x-forwarded-for')` parsed safely. There is
   * a deliberate **no-fallback-to-empty-string** rule — if no IP can be
   * extracted, the default returns `null` and the request is skipped
   * rather than bucketed against `''` (which would otherwise throttle
   * every request behind a misconfigured proxy into a single bucket).
   *
   * @example  (req) => req.headers.get('x-api-key') ?? defaultKeyGenerator(req)
   */
  keyGenerator?: KeyGenerator<K>;

  /**
   * Prefix prepended to every store key. Defaults to `'rl'`. The prefix
   * lets multiple limiters share a Redis instance without collisions, and
   * lets consumers run dev/staging/prod against the same backing store.
   * Empty string is allowed for advanced users (e.g. mounting against an
   * existing key-space convention).
   */
  prefix?: string;

  /**
   * Logical scope name appended after `prefix` and before the user key.
   * Defaults to a stable hash of `algorithm` (so two limiters with the
   * same prefix but different policies cannot collide). Override to share
   * a counter across multiple deployments (e.g. `scope: 'global'`).
   */
  scope?: string;

  /**
   * Header style on result.headers. Default: `'rfc'`
   * (draft-ietf-httpapi-ratelimit-headers-10 — `RateLimit`,
   * `RateLimit-Policy`). `'legacy'` adds `X-RateLimit-Limit`,
   * `X-RateLimit-Remaining`, `X-RateLimit-Reset`. `'both'` emits both for
   * mixed-client compatibility. `'none'` opts out (consumer builds headers
   * themselves from `result.state`).
   */
  headerStyle?: HeaderStyle;

  /**
   * Build the 429 response when `middleware()` short-circuits. Default is
   * a `text/plain` body that reads the configured `message`. Override to
   * return JSON, HTML, or to mirror the response shape of an upstream API.
   *
   * @example
   *   responseBuilder: ({ state, key }) =>
   *     Response.json({ error: 'rate_limited', retryAfterMs: state.retryAfter }, {
   *       status: 429,
   *       headers: { 'retry-after': String(Math.ceil(state.retryAfter / 1000)) },
   *     })
   */
  responseBuilder?: (info: RateLimitResult & { req: Request }) => Response | Promise<Response>;

  /**
   * Plain-text body for the default 429 response. Default `'Too Many Requests'`.
   * Ignored when `responseBuilder` is supplied.
   */
  message?: string;

  /**
   * What to do when the underlying store throws. `false` (default) is
   * **fail-closed** — the manager propagates `STORE_UNAVAILABLE` to the
   * caller (safer when you would rather take the request path's 5xx
   * than accidentally let a flooded Redis through). `true` is
   * **fail-open** — the manager swallows the error, returns
   * `{ allowed: true, degraded: true }`, stamps `headerStyle` headers
   * from the last-known policy, and emits `rate-limit.error` via the
   * observability hook so ops can alert on it without dropping users.
   *
   * Applies symmetrically to `check()`, `peek()`, and the
   * `keyGenerator` throwing path (see §9.2). Throws from
   * `responseBuilder` and from the observability hook are **always**
   * swallowed — those code paths are independent of `failOpen`.
   */
  failOpen?: boolean;

  /**
   * Default cost per `check()` call. Overridable per-call via
   * `check(req, { cost: 5 })`. Useful for endpoints where one HTTP request
   * represents N billable units (e.g. token-counted LLM calls).
   *
   * MUST be a positive finite number. If `cost > capacity`, the limiter
   * resolves `allowed: false` immediately with `retryAfter` set to the
   * full window — it does NOT throw, because cost can be a runtime value
   * (LLM token estimate) and an unexpected throw at request time is worse
   * than a rejected request.
   */
  cost?: number;

  /**
   * Observability hooks. Receives a single discriminated event object so
   * consumers can wire metrics, logs, and alerts with one switch. See
   * `hookMode` below for execution semantics.
   */
  on?: RateLimitHook<K>;

  /**
   * How the observability hook is invoked. Default `'fire-and-forget'`:
   * the hook is scheduled via `queueMicrotask(() => void hook(event))`
   * and never awaited, so a slow hook cannot add to the request's
   * TTFB. This is the right default on Workers / Vercel Edge where
   * the manager has **no access** to `executionCtx.waitUntil` —
   * blocking the response on a 50 ms timeout would compound across
   * every request. `'sync'` awaits the hook (bounded by
   * `hookTimeoutMs`, default 50 ms) — useful for tests that need
   * to assert observation order, and acceptable on long-running Node
   * processes where TTFB cost is amortised. `'wait-until'` is opt-in
   * for framework adapters that own `executionCtx`; the Hono /
   * SvelteKit adapters set this automatically when they detect the
   * binding (see §9.7).
   */
  hookMode?: 'fire-and-forget' | 'sync' | 'wait-until';

  /** Bound on `'sync'` hook duration. Ignored in fire-and-forget. */
  hookTimeoutMs?: number;

  /**
   * Override the wall clock. Defaults to `() => Date.now()`. Useful for
   * deterministic tests and for runtimes with `Date.now()` quirks (e.g.
   * Cloudflare Workers' coarsened clock during the I/O suspension period).
   */
  clock?: () => number;
}

export type HeaderStyle = 'rfc' | 'legacy' | 'both' | 'none';

export type KeyGenerator<K = undefined> = (
  req: Request,
  ctx: KeyGeneratorContext,
) =>
  | string
  | null
  | undefined
  | { key: string; context: K }
  | Promise<string | null | undefined | { key: string; context: K }>;

export interface KeyGeneratorContext {
  /** Cloudflare-supplied client IP if available (`request.cf?.connectingIp`). */
  readonly connectingIp?: string;
  /** Vercel/Next.js geo info if available. */
  readonly geo?: { country?: string; region?: string };
  /** Tenant id resolved by an upstream middleware, if your framework adapter
   *  forwarded it. The core never populates this; framework adapters MAY. */
  readonly tenant?: string;
}

export type Duration =
  | number
  | `${bigint}${' ' | ''}${'ms' | 's' | 'm' | 'h' | 'd'}`
  | { milliseconds?: number; seconds?: number; minutes?: number; hours?: number; days?: number };

export interface RateLimitObservation<K = undefined> {
  readonly type:
    | 'rate-limit.allowed'
    | 'rate-limit.blocked'
    | 'rate-limit.skipped'
    | 'rate-limit.error';
  readonly key: string;
  readonly state: RateLimitState;
  readonly algorithm: AlgorithmSpec;
  readonly cost: number;
  readonly startedAt: number;
  readonly elapsedMs: number;
  /** HTTP method extracted from the request — convenient for per-route
   *  Prometheus labels without re-parsing the key. */
  readonly method: string;
  /** Pathname extracted from the request URL (no query string). */
  readonly path: string;
  /** The raw `Request`. Provided for advanced consumers; most should read
   *  the structured `method` / `path` fields above. Kept readonly. */
  readonly request: Request;
  /** Caller context returned by the structured key generator. */
  readonly context: K;
  /** Present iff `type === 'rate-limit.error'`. */
  readonly error?: RateLimitError;
}

export type RateLimitHook<K = undefined> = (
  event: RateLimitObservation<K>,
) => void | Promise<void>;
```

### 2.6 Store contract (write your own adapter)

```ts
/**
 * Storage contract every adapter implements. The contract is intentionally
 * **algorithm-aware** — the store dispatches on `spec.kind` to pick the
 * right atomic primitive (Redis EVAL script, KV CAS loop, in-memory
 * critical section, D1 single-statement CTE). Centralising the algorithm
 * logic in the store, rather than the manager, is what lets the manager
 * stay zero-knowledge about Lua scripts / SQL / KV semantics.
 *
 * Stores SHOULD honour native TTL where the backend exposes one (Redis
 * EXPIRE, KV expirationTtl, DO alarms). Stores MUST NOT mutate state on
 * `peek` — the manager separates the two operations precisely so consumers
 * can introspect quotas without consuming them.
 *
 * All methods are async even when the implementation is synchronous (the
 * memory store) so adapters can be swapped without touching call sites.
 */
export interface RateLimitStore {
  /**
   * Atomically apply the algorithm and return the resulting state. The
   * call is the **single source of truth** for the rate limit decision —
   * the manager neither pre-checks nor post-corrects the result.
   *
   * @param key  Fully-qualified storage key (`{prefix}:{scope}:{userKey}`).
   * @param spec Algorithm spec (sliding window / token bucket / etc.).
   * @param cost Permits requested. MUST be `≥ 0`. Cost `0` is a peek-like
   *             "evaluate the current bucket without consuming"; the
   *             manager exposes `peek()` rather than `check({ cost: 0 })`
   *             but the store contract permits both for adapter authors.
   * @param now  Wall-clock milliseconds, supplied by the manager via
   *             `config.clock`. Stores SHOULD prefer this value over
   *             reading their own clock so distributed deployments share
   *             a single time source where possible.
   */
  consume(
    key: string,
    spec: AlgorithmSpec,
    cost: number,
    now: number,
  ): Promise<RateLimitState & { allowed: boolean }>;

  /**
   * Read the current state for a key without consuming. Returns the same
   * shape as `consume(..., cost: 0)` would, but with `allowed: true` —
   * peek is a query, not a decision.
   */
  peek(key: string, spec: AlgorithmSpec, now: number): Promise<RateLimitState>;

  /** Reset the counter for a key. Returns `true` iff state existed. */
  reset(key: string): Promise<boolean>;

  /**
   * Optional bulk garbage collection of expired records. Stores with
   * native TTL (Redis, KV) implement this as a no-op. Stores without
   * native TTL (memory, D1) implement it as a sweep call back-stopped
   * by sweepIntervalMs in their own constructor.
   */
  sweep?(now?: number): Promise<number>;

  /**
   * Optional human-readable label that adapters set so observability
   * events and error messages name the backend (`'redis'`, `'kv'`, …).
   * The manager prefixes it onto wrapped errors.
   */
  readonly name?: string;
}
```

### 2.7 Adapter signatures

> **Cloudflare adapters require `@cloudflare/workers-types`** as an
> optional peer dependency. The published `.d.ts` files for
> `adapters/cloudflare-kv`, `adapters/cloudflare-d1` and
> `adapters/durable-object` reference the global `KVNamespace`,
> `D1Database` and `DurableObjectNamespace` types directly (no internal
> shim) so consumers see the same types Wrangler generates. Workers
> users already have `@cloudflare/workers-types` installed; non-Workers
> consumers can ignore the peer entry — `peerDependenciesMeta` marks it
> optional, so npm/pnpm/bun installers do not warn. The per-adapter
> README block calls this out at install time.

```ts
// @devkit/ratelimit/adapters/memory
/**
 * In-process LRU store — single-threaded JS so every operation is atomic
 * by construction. `maxSize` caps memory by evicting the least-recently
 * touched key once the store reaches the bound; defaults to 10 000 keys.
 * `sweepIntervalMs` controls the periodic expired-entry sweep; default
 * 30 s, set to `0` to disable for short-lived processes.
 */
export function createMemoryStore(opts?: {
  maxSize?: number;
  sweepIntervalMs?: number;
}): RateLimitStore;

// @devkit/ratelimit/adapters/redis
/**
 * Redis store — uses Lua `EVAL` for single-RTT atomic check+decrement,
 * one script per algorithm kind. Scripts are loaded with `SCRIPT LOAD`
 * lazily on first use and cached by SHA, so subsequent calls go through
 * `EVALSHA` (one round-trip, ~50 µs on a colo'd Redis).
 *
 * The `RedisLike` interface is a narrow shape — the adapter does NOT
 * import `ioredis` or `redis`; bring your own client. Both `ioredis` and
 * `redis@^4` satisfy the shape natively.
 */
export function createRedisStore(
  client: RedisLike,
  opts?: { keyPrefix?: string },
): RateLimitStore;

export interface RedisLike {
  eval(script: string, keys: number, ...args: (string | number)[]): Promise<unknown>;
  evalsha(sha: string, keys: number, ...args: (string | number)[]): Promise<unknown>;
  scriptLoad?(script: string): Promise<string>;
  // Fallback path when EVAL is unavailable (Upstash legacy mode):
  multi?(): RedisMultiLike;
}

// @devkit/ratelimit/adapters/upstash
/**
 * Upstash REST store — same Lua scripts as the Redis adapter, executed via
 * Upstash's `eval` REST primitive. One HTTP round-trip per check; expect
 * 25–60 ms within the same region, higher cross-region. Includes a tiny
 * SHA-cache so the second call onward uses `evalsha`.
 *
 * Required peer dep: `@upstash/redis` (only types — runtime is REST).
 */
export function createUpstashStore(
  redis: import('@upstash/redis').Redis,
  opts?: { keyPrefix?: string },
): RateLimitStore;

// @devkit/ratelimit/adapters/cloudflare-kv
/**
 * Cloudflare KV store — eventually consistent, ≤60 s global staleness
 * window per CF docs. The adapter uses `get(..., { type: 'json' })` +
 * conditional `put` with a CAS metadata token; under contention this
 * degrades to "best-effort" with documented worst-case overshoot of 1.
 *
 * Use this only when "approximately N per minute, somewhere in the
 * world" is acceptable. For billing-critical / security-critical quotas
 * use `createDurableObjectStore` instead — the README cross-links
 * the two prominently.
 */
export function createKVStore(
  kv: KVNamespace,
  opts?: { keyPrefix?: string },
): RateLimitStore;

// @devkit/ratelimit/adapters/cloudflare-d1
/**
 * Cloudflare D1 store — single-statement `WITH inserted AS (...) UPDATE
 * ... RETURNING` CTE per algorithm kind. Strong consistency within a
 * single D1 region. Schema (one table, two indexes) ships in `schema.sql`;
 * users run it once via `wrangler d1 execute` before first deploy.
 */
export function createD1Store(
  db: D1Database,
  opts?: { table?: string; keyPrefix?: string },
): RateLimitStore;

// @devkit/ratelimit/adapters/durable-object
/**
 * Durable Object store — strong consistency within a single object. Each
 * rate-limit key resolves to a single DO instance via
 * `idFromName(prefix:scope:key)`, so all check / peek / reset RPCs to
 * that key go to the same isolate and serialise naturally.
 *
 * The adapter ships a reference DO class users can re-export from their
 * worker (or subclass to add custom alarms). For deployments that want
 * per-tenant DO partitioning (one DO per organisation rather than per
 * key) the README has a recipe pattern.
 */
export function createDurableObjectStore(
  namespace: DurableObjectNamespace,
  opts?: { keyPrefix?: string },
): RateLimitStore;

// Re-exported reference implementation:
export { RateLimitDurableObject } from './ratelimit-do.js';
```

### 2.8 Framework adapters — examples

```ts
// @devkit/ratelimit/frameworks/hono
//
// Limiter-as-input: the user constructs the limiter and hands it to the
// adapter. The adapter exposes the result on `c.var.rateLimit` for
// downstream handlers that want to surface remaining quota in their JSON
// response. Zero `declare module` augmentation; the adapter signature
// threads the limiter's `K` generic through Hono's `Variables`, so a
// `keyGenerator` returning `{ key, context: { tenantId: string } }`
// surfaces as a fully typed `c.var.rateLimit.context.tenantId`. The
// adapter also auto-detects `c.executionCtx` and switches the
// observability hook to `waitUntil` mode (see §2.5 `hookMode`).
export function honoRateLimit<K = undefined>(
  limiter: RateLimiter<K>,
  opts?: { onLimit?: (c: import('hono').Context) => Response | Promise<Response> },
): import('hono').MiddlewareHandler<{
  Variables: { rateLimit: RateLimitResult<K> };
}>;

// @devkit/ratelimit/frameworks/express
export function expressRateLimit<K = undefined>(
  limiter: RateLimiter<K>,
): (req: ExpressReq, res: ExpressRes, next: () => void) => Promise<void>;

// @devkit/ratelimit/frameworks/next
export function withRateLimit<H extends RouteHandler, K = undefined>(
  limiter: RateLimiter<K>,
  handler: H,
): H;
export function rateLimitMiddleware<K = undefined>(
  limiter: RateLimiter<K>,
  matcher?: (req: import('next/server').NextRequest) => boolean,
): (req: import('next/server').NextRequest) => Promise<import('next/server').NextResponse>;
```

### 2.9 Composable rules — `@devkit/ratelimit/compose`

```ts
/**
 * **Logical AND.** Run every limiter in declaration order; the first one
 * to **block** wins. Layers that allow have already **consumed** their
 * permit by the time a later layer blocks — this is the correct semantics
 * for layered quotas (per-IP + per-key + per-tenant where any one
 * exhausting blocks the request) but it is a foot-gun if you're hoping
 * for short-circuit-on-allow. Read the type:
 *
 *   `composeAll([ipLimit, keyLimit, tenantLimit])`
 *
 * The name reads as "all must allow"; the docblock and the README block
 * spell out the consume-on-allow side-effect prominently. Each layer
 * emits its own `rate-limit.allowed | rate-limit.blocked` observation,
 * so dashboards can attribute consumption to the layer that drove it.
 *
 * Headers from intermediate "allowed" layers are **merged** alongside
 * the binding (blocking) layer's headers so clients see all active
 * policies in the response.
 */
export function composeAll(limiters: readonly RateLimiter[]): RateLimiter;

/**
 * **Logical OR with short-circuit on the first allow.** Tries each
 * limiter in declaration order and returns the first `allowed: true`
 * result **without consuming permits in subsequent layers**. Use this
 * for "any one of these grants permission" — e.g. a paid-tier API key
 * bypasses the per-IP quota. If every layer blocks, returns the result
 * from the layer with the **soonest `retryAfter`** (so the client gets
 * the most actionable wait time). Per-layer observations are emitted
 * for every layer that was consulted (not just the winning one), so
 * dashboards can see which tiers were attempted.
 */
export function composeFirstAllowed(limiters: readonly RateLimiter[]): RateLimiter;

/**
 * Tier-resolved limiter — the resolver picks one limiter per request
 * (e.g. by API plan) and the chosen limiter handles the check.
 *
 * **Unknown-tier policy:** when the resolver returns a tier that is not
 * in `tiers` and no `fallback` is supplied, the limiter **skips** the
 * request (returns `{ allowed: true }`) and emits a
 * `rate-limit.skipped` observation tagged with the unknown tier name.
 * This avoids turning a resolver/config drift into a production 5xx;
 * ops teams alert on a non-zero `skipped` rate instead. Pass
 * `fallback: someLimiter` to apply a catch-all policy instead of
 * skipping. (The previous draft of this plan threw `INVALID_TIER` —
 * production safety wins over fail-loud here.)
 */
export function tieredRateLimiter<Tier extends string>(opts: {
  resolve: (req: Request) => Tier | Promise<Tier>;
  tiers: Record<Tier, RateLimiter>;
  fallback?: RateLimiter;
}): RateLimiter;

/**
 * Rule-based limiter — each rule has a predicate and a limiter; the
 * first matching rule handles the check. Rules are evaluated top-down,
 * so order matters. `fallback` runs when no rule matched.
 */
export function ruledRateLimiter(opts: {
  rules: ReadonlyArray<{ when: (req: Request) => boolean | Promise<boolean>; use: RateLimiter }>;
  fallback?: RateLimiter;
}): RateLimiter;
```

### 2.10 Ideal DX — Hono + Cloudflare Durable Objects

The minimum useful limiter is **two imports** in sugar form, three in
spec form. We show both — sugar first because that's what most users
should write, then spec form for size-sensitive deployments.

```ts
// Sugar form — minimal imports, recommended for getting started.
import { Hono } from 'hono';
import { createRateLimiter } from '@devkit/ratelimit';
import { createDurableObjectStore, RateLimitDurableObject } from '@devkit/ratelimit/adapters/durable-object';
import { honoRateLimit } from '@devkit/ratelimit/frameworks/hono';
import { composeAll } from '@devkit/ratelimit/compose';

interface Env {
  RATELIMIT_DO: DurableObjectNamespace;
}

// Re-export the DO class so wrangler binds it.
export { RateLimitDurableObject };

const app = new Hono<{ Bindings: Env }>();

app.use('*', async (c, next) => {
  const store = createDurableObjectStore(c.env.RATELIMIT_DO);

  // Layered: 1000/min per IP, plus burst-friendly 50-token bucket per API key.
  const ipLimit = createRateLimiter({
    algorithm: 'sliding-window',
    limit: 1000,
    window: '1 m',
    store,
    prefix: 'rl:ip',
  });
  const keyLimit = createRateLimiter<{ tenantId: string }>({
    algorithm: 'token-bucket',
    capacity: 50,
    refill: 5,
    interval: '1 s',
    store,
    prefix: 'rl:key',
    keyGenerator: (req) => {
      const apiKey = req.headers.get('x-api-key');
      if (!apiKey) return null;
      return { key: apiKey, context: { tenantId: tenantOf(apiKey) } };
    },
  });

  // composeAll = "every layer must allow"; intermediate layers consume
  // their permit on the way through. See §2.9 for composeFirstAllowed.
  const limiter = composeAll([ipLimit, keyLimit]);
  return honoRateLimit(limiter)(c, next);
});

app.post('/v1/complete', (c) => {
  // Both .state.remaining and .context.tenantId are typed end-to-end
  // because honoRateLimit threaded the limiter's K generic through.
  const { remaining } = c.var.rateLimit.state;
  const { tenantId } = c.var.rateLimit.context;
  return c.json({ ok: true, remaining, tenantId });
});
```

The same setup in spec form drops ~200 B from the core (the algorithm
factories tree-shake the inline normalisers) at the cost of two
additional imports per algorithm:

```ts
// Spec form — minimum bundle size; recommended for size-budgeted edge deploys.
import { slidingWindow } from '@devkit/ratelimit/algorithms/sliding-window';
import { tokenBucket } from '@devkit/ratelimit/algorithms/token-bucket';

const ipLimit = createRateLimiter({
  algorithm: slidingWindow({ limit: 1000, window: '1 m' }),
  store, prefix: 'rl:ip',
});
const keyLimit = createRateLimiter({
  algorithm: tokenBucket({ capacity: 50, refill: 5, interval: '1 s' }),
  store, prefix: 'rl:key',
});
```

---

## 3. Internal Architecture

### 3.1 Module dependency graph

```
                       ┌─────────────────────┐
                       │   src/index.ts       │ public root
                       └─────────┬───────────┘
                                 ▼
                       ┌─────────────────────┐
                       │ core/limiter.ts      │ orchestrator
                       └─┬──────┬──────┬─────┘
                         │      │      │
            ┌────────────┘      │      └────────────┐
            ▼                   ▼                    ▼
    ┌──────────────┐   ┌────────────────┐    ┌──────────────┐
    │ core/        │   │ core/headers   │    │ types/*      │
    │ consume.ts   │   │ core/response  │    │ (zero-runtime)│
    └──┬───────────┘   └────────┬───────┘    └──────────────┘
       │                        ▼
       │                ┌──────────────┐
       │                │ core/        │   formatting only —
       │                │ duration.ts  │   no runtime side effects
       │                │ core/key.ts  │
       │                │ core/time.ts │
       │                └──────────────┘
       │
       └──► RateLimitStore (interface, no runtime import)
            algorithms/* (data-only; never imported by core/*)
            adapters/* (subpath; never imported by core/*)
            frameworks/* (subpath; never imported by core/*)
```

`RateLimitStore` is an **interface**, not an import — adapters live behind
their own subpath exports and are pulled in only when the user imports
them. `algorithms/*` modules are **data factories**: they return
`AlgorithmSpec` plain objects and never import any runtime code from
`core/*`. The core (`src/index.ts`) statically imports zero algorithm
logic, zero adapter logic, and zero framework adapter logic — so a build
that imports only `slidingWindow` + `createMemoryStore` ships ~3.5 KB
total.

### 3.2 Data flow — the `check()` lifecycle

```
Request ──► keyGenerator(req, ctx)
              │
              ▼ (null/'' → skip + emit 'rate-limit.skipped' → allowed:true)
        composeKey(prefix, scope, userKey)
              │
              ▼
        store.consume(key, spec, cost, now)        ◄── ATOMIC per adapter
              │                                          (Lua / SQL / DO RPC /
              │                                           single-thread crit-section)
              ▼
        consumeResult: { allowed, limit, remaining, reset, retryAfter }
              │
              ▼
        buildHeaders(state, headerStyle)
              │
              ▼
        observe('rate-limit.allowed' | 'rate-limit.blocked', …)
              │
              ▼
        RateLimitResult { allowed, key, state, headers }   ──► caller
```

Mutating ops (`reset`, `resetKey`) follow the same prefix → store dispatch.
The `middleware()` shim wraps `check()` and translates `allowed: false`
into the configured `responseBuilder(...)` — a single hop, zero internal
state.

### 3.3 Key design patterns

- **Adapter pattern (storage + framework)** — two orthogonal axes. The
  core engine works with **one** small interface (`RateLimitStore`); every
  storage adapter is a thin glue layer ≤300 LOC. Framework adapters are
  even thinner (≤100 LOC each) because the limiter already speaks Web
  Standards — they only translate the framework's request/response shape
  in and out.
- **Algorithm-as-data** — `AlgorithmSpec` is a discriminated union of
  plain data objects, not classes. The store dispatches on `spec.kind`
  to a per-algorithm Lua / SQL / in-memory routine. Two consequences:
  (1) the manager imports zero algorithm code, so unused algorithms
  tree-shake completely; (2) adding a new algorithm is a pure additive
  change to the store contract — no manager changes.
- **Pure core, impure edges** — every function in `core/*` is pure with
  injected `now()` and explicit `Request` input. Side effects (network,
  process.env access, `console.warn`) live in `adapters/*` and
  `utils/env.ts`. The test suite exercises 80 % of code paths with
  zero mocks.
- **Frozen handles** — `createRateLimiter` returns an `Object.freeze`d
  object so callers cannot accidentally mutate config at runtime
  (subtle bug source on long-lived workers).
- **Single time source** — every clock read goes through `core/time.ts`,
  swapped via `config.clock`. Eliminates flaky tests around clock skew
  and lets distributed deployments share a single shifted clock if
  required (e.g. a Lambda runtime with a known ~30 ms NTP drift).
- **Best-effort vs strong consistency, declared per adapter** — the
  README and each adapter's TSDoc explicitly state which consistency
  guarantee the user gets. KV: best-effort, ≤60 s staleness. DO: strong
  within the object. Redis: strong (single shard) / eventual (cluster).
  D1: strong within the region. Memory: strong within the process.
  This is the **single most-asked rate-limiter question** in the
  ecosystem and we put the answer right next to the constructor.
- **Lua-script-once, deploy-everywhere** — the same five Lua scripts
  power both `adapters/redis` and `adapters/upstash` (re-exported, not
  duplicated). Adding a sixth algorithm means writing one Lua script
  and one in-memory implementation in the memory store; KV / D1 / DO
  follow with their native primitives. Single source of truth for the
  algorithmic correctness proof.
- **Zero `any`, no internal casts** — `as` is banned by Biome rule
  outside `core/algorithm-spec.ts` (discriminated union narrowing) and
  `adapters/*/index.ts` (raw Redis return value coercion behind a
  single `parseConsumeResult` function). Runtime validation of decoded
  store payloads happens at the boundary, not deep inside the engine.

---

## 4. Type System

### 4.1 The `AlgorithmSpec` discriminated union

`AlgorithmSpec` is the central type that flows from algorithm factories
into the store. The discriminator is `kind`, a string literal type the
store narrows on. Every variant carries a **brand** so the only way to
construct one is through the corresponding factory (or the sugar
overload's inlined normaliser, which goes through the same internal
mint helper). A consumer who tries to write
`{ kind: 'token-bucket', capacity: -1, refill: 0, intervalMs: 0 } as AlgorithmSpec`
gets a compile-time error on the `as` cast because the brand symbol is
not assignable from outside the package; the value is **read-assignable**
to `AlgorithmSpec` (so storage adapter authors can still type their
parameters as `AlgorithmSpec` and pattern-match the union) but not
**write-constructible** by hand.

```ts
declare const AlgorithmBrand: unique symbol;
type Branded<K extends string> = { readonly [AlgorithmBrand]: K };

export type AlgorithmSpec =
  | (Branded<'sliding-window-counter'> & { kind: 'sliding-window-counter'; limit: number; windowMs: number })
  | (Branded<'sliding-window-log'>      & { kind: 'sliding-window-log';      limit: number; windowMs: number })
  | (Branded<'token-bucket'>            & { kind: 'token-bucket';            capacity: number; refill: number; intervalMs: number })
  | (Branded<'fixed-window'>            & { kind: 'fixed-window';            limit: number; windowMs: number })
  | (Branded<'leaky-bucket'>            & { kind: 'leaky-bucket';            capacity: number; leak: number; intervalMs: number });
```

The brand symbol is **not exported** — the only way to obtain a value of
this shape is through `slidingWindow()`, `tokenBucket()`, etc. (or the
sugar overload's internal normaliser). Adapter authors who need to
construct test fixtures import a `@internal` helper from
`@devkit/ratelimit/testing` (separate subpath, not in the published
surface; usable only via patched `exports`).

Every algorithm factory **normalises units at construction time** —
`Duration` → `windowMs` / `intervalMs` integers. The store never sees a
string `'1 m'`; it always sees `60_000`. This avoids parsing on the hot
path and lets the spec be cheaply hashed for the default `scope` value.

Adapters narrow on `spec.kind` via exhaustive `switch`:

```ts
switch (spec.kind) {
  case 'sliding-window-counter':  return runSlidingWindowCounter(spec, …);
  case 'sliding-window-log':      return runSlidingWindowLog(spec, …);
  case 'token-bucket':            return runTokenBucket(spec, …);
  case 'fixed-window':            return runFixedWindow(spec, …);
  case 'leaky-bucket':            return runLeakyBucket(spec, …);
}
// `spec` narrowed to `never` here — TS catches a missing case.
```

### 4.2 Conditional type for `RateLimiterMiddleware`

The middleware's return type encodes "Response when blocked, undefined
when allowed":

```ts
export type RateLimiterMiddleware = (req: Request) => Promise<Response | undefined>;
```

This narrows cleanly in user code:

```ts
const blocked = await middleware(req);
if (blocked) return blocked;       // `blocked` narrows to Response
// fall through, `blocked` is `undefined` here.
```

### 4.3 Branded types — internal only

`StoreKey` (the fully-qualified `prefix:scope:userKey`) is **branded** in
`src/types/key.ts` so `core/limiter.ts` cannot accidentally hand a raw
user key to `store.consume`:

```ts
declare const StoreKey: unique symbol;
type StoreKey = string & { readonly [StoreKey]: 'StoreKey' };
```

The brand is **not exported**. Public APIs (`resetKey(key: string)`,
`config.keyGenerator returns string`) all take/return plain `string`;
the brand is applied internally inside `core/key.composeKey()`, the
sole entrypoint for branded keys. This preserves the safety property
(no key-mixup in engine code) without forcing consumers to cast or to
adopt a `StoreKey` type they cannot construct.

### 4.4 `Duration` template literal

```ts
export type Duration =
  | number
  | `${bigint}${' ' | ''}${'ms' | 's' | 'm' | 'h' | 'd'}`
  | { milliseconds?: number; seconds?: number; minutes?: number; hours?: number; days?: number };
```

The template-literal form uses TypeScript's `${bigint}` placeholder
(not `${number}`) so the type **rejects decimals and signs at compile
time**: `'1m'`, `'500ms'`, `'1 h'`, `'60 s'` all type-check;
`'1.5h'`, `'-1m'`, `'NaN s'`, `'1 minute'` are TS errors at the
call site. (`${number}` would have accepted decimals, signs, exponents
and `NaN` — the previous draft of this plan claimed compile-time
rejection without delivering it.) Fractional values must use the
object form (`{ minutes: 1.5 }`) so the truncation is explicit, and
the runtime parser in `core/duration.ts` re-validates the string with
a regex as a defence-in-depth check (`/^[0-9]+\s?(ms|s|m|h|d)$/`) for
consumers who pass a non-literal `string` widened away from the
template type.

### 4.5 Compile-time guarantees enforced

- `noUncheckedIndexedAccess` — every `headers.get(name)` is `string |
  undefined`, so the default key extractor cannot pretend an absent
  `cf-connecting-ip` is a string.
- `exactOptionalPropertyTypes` — `responseBuilder?:` rejects `undefined`
  assignments, so `undefined` and "not set" are distinguishable for
  config merging.
- `verbatimModuleSyntax` — `import type` is enforced; the build never
  emits type-only imports as runtime imports (broken Workers bundles).
- `useUnknownInCatchVariables` — every `catch` proves it received an
  unknown before touching the value; eliminates a class of CVEs where
  `err.code` is read after a non-Error throw.
- **Exhaustive `switch` on `spec.kind`** — adapters that miss a case
  are rejected at compile time via the `never` narrowing pattern.

---

## 5. Error Handling Strategy

### 5.1 When to throw vs return `RateLimitResult`

| Operation                            | Failure mode                  | Behaviour                                              |
|--------------------------------------|-------------------------------|--------------------------------------------------------|
| `limiter.check(req)`                 | over the limit                | **return `{ allowed: false, ... }`** — never throws    |
| `limiter.check(req)`                 | `keyGenerator` returns `null` | **return `{ allowed: true, ... }`** + `'rate-limit.skipped'` event |
| `limiter.check(req)`                 | `keyGenerator` throws (`failOpen: false`) | **throw `INVALID_KEY`** — wraps the original cause     |
| `limiter.check(req)`                 | `keyGenerator` throws (`failOpen: true`)  | return `{ allowed: true, degraded: true }` + `'rate-limit.error'` event — a buggy extractor cannot DoS the API |
| `limiter.check(req)`                 | store unreachable (`failOpen: false` — default) | **throw `STORE_UNAVAILABLE`**                          |
| `limiter.check(req)`                 | store unreachable (`failOpen: true`)            | return `{ allowed: true, degraded: true }` + `'rate-limit.error'` event |
| `limiter.check(req)`                 | `cost > capacity`             | return `{ allowed: false, retryAfter: window }`        |
| `limiter.check(req, { cost: -1 })`   | invalid cost                  | **throw `INVALID_COST`** — programmer error            |
| `limiter.peek(req)`                  | store unreachable (`failOpen: false`) | **throw `STORE_UNAVAILABLE`**                          |
| `limiter.peek(req)`                  | store unreachable (`failOpen: true`)  | return `{ allowed: true, degraded: true }` carrying the last-known state (zero values when no prior observation exists) |
| `limiter.reset(req)`                 | nothing to reset              | resolve `false` — idempotent                           |
| `limiter.middleware()(req)`          | over the limit                | resolve `Response` (429) — never throws                |
| `createRateLimiter(config)`          | invalid algorithm spec        | **throw at construction `INVALID_CONFIG`**             |
| `slidingWindow({ limit: 0 })`        | impossible bound              | **throw at construction `INVALID_CONFIG`**             |
| `tieredRateLimiter` — unknown tier, no fallback | resolver drift     | return `{ allowed: true }` + `'rate-limit.skipped'` event tagged with the unknown tier name (was `INVALID_TIER` throw — production safety) |

The rule of thumb: **the request hot path never throws on user-controlled
inputs** (over-the-limit, missing IP, bad client headers — all
user-supplied and should not generate 5xx). Throws are reserved for
programmer errors (negative cost, missing store) and infrastructure
failures (Redis down, with `failOpen: false`).

### 5.2 `RateLimitError` shape

```ts
export class RateLimitError extends Error {
  readonly name = 'RateLimitError';
  readonly code: RateLimitErrorCode;
  /** Original cause when wrapping store / network errors. Not serialised. */
  readonly cause?: unknown;
  /** Safe-to-log message — never includes raw user input or secrets. */
  readonly publicMessage: string;
  constructor(code: RateLimitErrorCode, message: string, cause?: unknown);
  static is(value: unknown): value is RateLimitError;
}

export type RateLimitErrorCode =
  | 'INVALID_CONFIG'        // bad algorithm spec / window / capacity
  | 'INVALID_COST'          // cost ≤ 0 or non-finite at runtime
  | 'INVALID_KEY'           // keyGenerator returned a non-string non-null
  | 'INVALID_TIER'          // tieredRateLimiter resolver returned an unknown tier
  | 'STORE_UNAVAILABLE'     // adapter threw during consume / peek / reset
  | 'WINDOW_TOO_LARGE'      // window > store's TTL ceiling (Redis 49.7d, KV 365d)
  | 'PAYLOAD_TOO_LARGE'     // sliding-window-log set size > store row limit
  | 'KEY_TOO_LONG';         // composed key > backend max (Redis 512MB, KV 512B)
```

`RateLimitError.is(value)` works across realm boundaries (Workers ↔
Durable Objects), where `instanceof` fails. It checks `name === 'RateLimitError'`
and presence of the `code` field.

### 5.3 Adapter error wrapping

Every adapter wraps thrown infrastructure errors in
`new RateLimitError('STORE_UNAVAILABLE', '${store.name}: ${detail}', { cause: original })`
so consumers get a stable error code regardless of which store they
chose. The original `cause` is preserved for debugging; the
`publicMessage` is safe to log without leaking connection strings or
keys.

### 5.4 Observability-first signalling

For every "expected" event (`allowed`, `blocked`, `skipped`, `error`)
the manager emits a structured `RateLimitObservation` to the configured
`on` hook. This lets ops teams build dashboards on rate-limit anomalies
(spike of `blocked` from one CIDR, sudden `error` rate from a store)
without instrumenting the library themselves.

**The hook never blocks the request path by default.** The default
`hookMode` is `'fire-and-forget'`: the manager schedules the hook via
`queueMicrotask(() => void hook(event).catch(noop))` and returns the
result immediately. This matters most on Cloudflare Workers and Vercel
Edge — runtimes where the bare middleware path has **no access** to
`executionCtx.waitUntil`, so any `await`ed hook would directly add to
TTFB on every request. The fire-and-forget tradeoff is that on
short-lived edge isolates a hook call may be cancelled mid-flight
when the response settles; for guaranteed delivery, either:

  1. Set `hookMode: 'wait-until'` and use a framework adapter that
     wires `executionCtx.waitUntil` (Hono, SvelteKit auto-detect; bare
     Workers users pass `executionCtx` to the limiter explicitly), or
  2. Set `hookMode: 'sync'` on long-lived Node processes where the
     extra `await` is amortised and observation order matters (tests
     are the canonical case — set `'sync'` in the test setup).

The `'sync'` mode bounds the hook at `hookTimeoutMs` (default 50 ms);
slower hooks are dropped with a one-shot dev warning. The
`'fire-and-forget'` mode applies no timeout — the runtime takes the
hook with whatever scheduling guarantees it provides.

---

## 6. Bundle & Tree-shaking Plan

### 6.1 Entry points

The package ships **20+ subpath exports**, every one a leaf module that
the bundler can tree-shake on its own. The user pays only for what they
import.

Budgets below count **library code only** (size-limit measured on
`dist/**/*.js` per entry, gzip). Zero runtime dependencies — the
core ships nothing but its own code, so the headline number is honest:
**≤6 KB for `@devkit/ratelimit` + one algorithm + one store**.

| Subpath                                       | Library budget | Notes                                          |
|-----------------------------------------------|---------------|-------------------------------------------------|
| `@devkit/ratelimit`                           | **3.2 KB**    | core engine — limiter + consume + headers + response + duration + key + time + invariant + the sugar-overload's inlined algorithm-spec normalisers (~0.2 KB across all five). Zero adapter code. Spec-form-only consumers can ignore the normalisers; they tree-shake when nothing imports the sugar overload signature. |
| `@devkit/ratelimit/errors`                    | **0.4 KB**    | `RateLimitError` + codes                         |
| `@devkit/ratelimit/algorithms/sliding-window` | **0.5 KB**    | counter approximation factory                    |
| `@devkit/ratelimit/algorithms/sliding-window-log` | **0.5 KB** | exact-bound factory                              |
| `@devkit/ratelimit/algorithms/token-bucket`   | **0.5 KB**    | refill arithmetic                                |
| `@devkit/ratelimit/algorithms/fixed-window`   | **0.4 KB**    | simplest factory                                 |
| `@devkit/ratelimit/algorithms/leaky-bucket`   | **0.5 KB**    | leak arithmetic                                  |
| `@devkit/ratelimit/adapters/memory`           | **0.8 KB**    | LRU + per-algorithm in-process routines          |
| `@devkit/ratelimit/adapters/redis`            | **2.0 KB**    | Lua scripts inlined as strings + EVAL/EVALSHA shim |
| `@devkit/ratelimit/adapters/upstash`          | **1.6 KB**    | re-imports `redis/lua.ts` + REST eval shim       |
| `@devkit/ratelimit/adapters/cloudflare-kv`    | **1.2 KB**    | CAS loop + per-algorithm in-process routines     |
| `@devkit/ratelimit/adapters/cloudflare-d1`    | **1.4 KB**    | prepared statements per algorithm                |
| `@devkit/ratelimit/adapters/durable-object`   | **0.9 KB**    | DO RPC client + reference DO class               |
| `@devkit/ratelimit/frameworks/hono`           | **0.4 KB**    | Web-Standard adapter; thin                       |
| `@devkit/ratelimit/frameworks/elysia`         | **0.4 KB**    | Web-Standard adapter; thin                       |
| `@devkit/ratelimit/frameworks/express`        | **0.7 KB**    | (req,res,next) → Web Standard shim               |
| `@devkit/ratelimit/frameworks/fastify`        | **0.5 KB**    | fastify-plugin wrapper                           |
| `@devkit/ratelimit/frameworks/next`           | **0.7 KB**    | Route Handler wrapper + middleware split         |
| `@devkit/ratelimit/frameworks/sveltekit`      | **0.5 KB**    | handle wrapper                                   |
| `@devkit/ratelimit/compose`                   | **0.7 KB**    | composeAll + composeFirstAllowed + tiered + ruled |

Budgets are enforced in CI via `size-limit` (see `.size-limit.json`). A
PR that breaks the budget fails the check. The 3.2 KB core is achievable
because no adapter or framework code is reachable from `src/index.ts` —
every adapter/framework module is its own subpath and is only pulled in
when the user explicitly imports it. Algorithms straddle: their data
factories live behind subpaths (`slidingWindow()` etc.), but a tiny
inlined normaliser table for each `kind` ships in the core to power the
sugar-form `createRateLimiter({ algorithm: 'sliding-window', ... })`
overload. The `~0.2 KB` cost of those inline normalisers is the
deliberate price for the headline DX win — most users avoid two
imports per algorithm.

A typical Cloudflare Workers deployment using sugar form + `KV`
ships **3.2 + 1.2 = ~4.4 KB** (no algorithm subpath needed). The same
code in spec form ships **3.0 + 0.5 + 1.2 = ~4.7 KB** (the spec form
trims the unused inline normalisers down to ~3.0 KB core because
nothing references them). On Bun + Redis it lands at **~5.3 KB**
sugar / **~5.5 KB** spec. We headline `≤6 KB` honestly: even the
heaviest cut (core + sliding-window-log + Redis + Hono) lands at
**~6 KB**.

### 6.2 Tree-shaking enablers

- `"sideEffects": false` in `package.json` — every module is pure (no
  top-level `console.warn`, no module-init side effects, no IIFE).
- **No barrel re-exports** in `src/core/*` or `src/algorithms/*` →
  re-exports happen only at package boundaries (`src/index.ts`,
  `src/errors/index.ts`, `src/compose/index.ts`), which are themselves
  tiny.
- **Per-algorithm subpath opt-in** — every algorithm factory lives at
  its own `@devkit/ratelimit/algorithms/{name}` subpath. The core
  (`src/index.ts`) has **zero** static imports of any algorithm
  module; the limiter dispatches dynamically on `spec.kind` inside
  whichever store the user picked. A consumer who imports only
  `slidingWindow` ships zero code from `tokenBucket`, `fixedWindow`,
  etc.
- **Lua scripts as inline strings, lazily registered** — the Redis
  adapter holds the five scripts as `const` string literals in
  `adapters/redis/lua.ts`. They are not loaded until the first
  `consume()` call for the matching `spec.kind`, so a consumer using
  only `slidingWindow` against Redis doesn't spend bytes parsing the
  other four scripts at startup (the strings are still in the bundle —
  ~1.2 KB total — but they're dead in the AST until used).
- **No defensive `try/catch` around imports** — every conditional
  import is dynamic when truly optional (e.g. the express adapter
  dynamically imports `node:querystring` only when called from
  Express ≤ 4 with a body parser that returned a `Buffer`).

### 6.3 ESM-only

The package is **pure ESM** (`"type": "module"`, no `require` build).
Every supported runtime ships native ESM in 2026 (Node 20+, Bun, Deno,
all edge runtimes). Avoiding the dual-package hazard saves ~0.8 KB
and a non-trivial maintenance surface (the `sliding-window-log`
sorted-set logic in particular is fiddly enough that we don't want to
maintain a second build of it).

### 6.4 Build pipeline

`tsup` produces ESM + DTS for each `src/**/index.ts` listed in
`tsup.config.ts`. Build invariants enforced in CI:

- `attw --pack .` — `arethetypeswrong` validates every subpath under
  all resolution modes (`node10`, `node16`, `bundler`).
- `publint` — catches `package.json` shape errors (missing `types`
  conditions, mis-ordered keys).
- `size-limit` — per-entry KB budgets (table above).
- `vitest run --typecheck` — `.test-d.ts` files exercise generic
  propagation (algorithm factories return narrowed `AlgorithmSpec`
  unions, the limiter's middleware narrows from
  `Promise<Response | undefined>` correctly, etc.).
- `vitest run --pool workers` — runs the Workers / KV / D1 / DO suite
  inside a real V8 isolate via `@cloudflare/vitest-pool-workers`.

---

## 7. Dependencies

### 7.1 Runtime dependencies

**None.** Zero runtime dependencies in the core. Every algorithm is
implemented in pure TypeScript using arithmetic and `Map` / `Array`
primitives; every store adapter speaks to its backend through a narrow
client interface that the consumer brings (no transitive `ioredis`,
`@upstash/redis`, etc.). The library depends only on the Web Standard
runtime APIs (`Request`, `Response`, `Headers`, `crypto.getRandomValues`,
`Date.now`).

The **strategic value** of zero deps for a rate limiter:

- **Bundle size** — every runtime dep is at least ~1 KB once minified;
  even one would push the core over its 6 KB headline.
- **Audit surface** — consumers of a rate limiter are typically
  security-aware. Zero deps means zero supply-chain risk added by
  `@devkit/ratelimit` itself.
- **Edge-runtime portability** — Cloudflare Workers, Vercel Edge and
  Deno disagree on which Node-builtins are polyfilled. Zero-deps means
  zero polyfill surprises.

### 7.2 Peer dependencies (all optional)

| Package                        | When                                    |
|--------------------------------|-----------------------------------------|
| `hono`                         | `frameworks/hono`                       |
| `elysia`                       | `frameworks/elysia`                     |
| `express`                      | `frameworks/express`                    |
| `fastify`                      | `frameworks/fastify`                    |
| `next`                         | `frameworks/next`                       |
| `@sveltejs/kit`                | `frameworks/sveltekit`                  |
| `@upstash/redis`               | `adapters/upstash` (types + Redis class) |
| `@cloudflare/workers-types`    | `adapters/cloudflare-kv`, `cloudflare-d1`, `durable-object` — types-only, **optional peer dep** so consumers who install one of those adapter subpaths get `KVNamespace` / `D1Database` / `DurableObjectNamespace` from the same versioned source Wrangler does. Without it the published `.d.ts` rollup raises TS2304. Workers users always have it installed; non-Workers consumers get no warning because of `peerDependenciesMeta` (see below). |

All peer deps are listed in `peerDependenciesMeta` with `"optional":
true`, so npm/pnpm/bun installers don't warn when a consumer skips an
unrelated adapter or framework. Redis (the runtime client) is
**explicitly not** a peer dep — the adapter accepts any object
matching the `RedisLike` interface, so consumers can use `ioredis`,
`redis@^4`, `node-redis`, a custom WebSocket-based client, or a mock.

### 7.3 Dev dependencies (high level)

`vitest`, `@vitest/coverage-v8`, `@cloudflare/vitest-pool-workers`,
`miniflare`, `tsup`, `@arethetypeswrong/cli`, `publint`,
`@biomejs/biome`, `size-limit`, `@size-limit/preset-small-lib`,
`@changesets/cli`, `ioredis`, `ioredis-mock`, `testcontainers` (real
Redis for integration tests), `supertest`, `msw` (Upstash REST mock),
plus `@types/node`, `@types/express`.

### 7.4 Why zero runtime deps and not a tiny utility

We deliberately **don't** depend on `ms` for duration parsing — the
parser in `core/duration.ts` is ~30 LOC and avoids a 4 KB transitive
dep. Similarly we don't depend on `lru-cache` for the memory store —
we ship a 40-line doubly-linked list LRU in `utils/lru.ts`. The
trade-off is justified: a rate limiter is in the request hot path, and
every byte counts; reusing a generic LRU library would add code paths
we don't exercise (size functions, dispose hooks, async fetch). The
hand-rolled versions are fully unit-tested and fixed in scope.

---

## 8. Configuration

### 8.1 `package.json` (scaffold — see file at repo root)

Highlights:

- `"name": "@devkit/ratelimit"`, `"version": "0.1.0"`, `"type": "module"`.
- `"sideEffects": false`.
- `"exports"` maps every subpath listed in §6.1 to its
  `dist/**/index.js` with the matching `types` condition first
  (NodeNext requires it).
- `"engines": { "node": ">=20" }` — Node 18 reached EoL in April 2025
  and Node 20 is the current LTS in 2026. The original research
  report (`reports/08-rate-limiter-universal.json`) lists "Node.js
  18+" as a runtime target; we deliberately diverge from that
  snapshot. The PLAN, `package.json`, and the README all align on
  Node 20+; the report is a point-in-time research artifact and is
  not updated retroactively.
- `"keywords"` matches the SEO list from the research report.
- `"scripts"` parallels the sibling `@authkit/sessions` library
  (`build`, `test`, `test:types`, `lint`, `format`, `size`,
  `publint`, `attw`, `release`).
- `"files": ["dist", "README.md", "LICENSE"]` — explicit allow-list
  is the source of truth; `.npmignore` is defence-in-depth.

### 8.2 `tsconfig.json`

```jsonc
{
  "compilerOptions": {
    "target": "ES2024",
    "lib": ["ES2024", "DOM", "DOM.Iterable"],
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "exactOptionalPropertyTypes": true,
    "useUnknownInCatchVariables": true,
    "isolatedModules": true,
    "verbatimModuleSyntax": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "rootDir": "src",
    "outDir": "dist",
    "types": ["node", "@cloudflare/workers-types"]
  },
  "include": ["src"]
}
```

A `tsconfig.build.json` extends this and excludes `test/` and
`**/*.test-d.ts` from emit.

### 8.3 `vitest.config.ts`

A single file with **two workspaces**:

1. **node** — default pool, runs
   `test/{core,algorithms,adapters,frameworks,compose,correctness,bench}/**`.
2. **workers** — `@cloudflare/vitest-pool-workers`, runs
   `test/runtime/workers.test.ts` against a real Workers V8 isolate +
   miniflare-bound KV / D1 / DO bindings.

Coverage thresholds: 95 % statements / 90 % branches across `src/core`
and `src/algorithms`; 80 % for adapters and frameworks (lower because
adapter integration is exercised in the workers workspace, not the
node pool).

### 8.4 `.gitignore`

See file at repo root. Convention: **no `./` prefix** on patterns
(critical — `./node_modules` silently fails to match when git evaluates
`.gitignore` relative to the repo root, and the result is `node_modules`
sneaking into commits).

### 8.5 `.npmignore`

Inverse-of-`.gitignore` approach: an explicit `files` array in
`package.json` (`["dist", "README.md", "LICENSE"]`) is the source of
truth — the `.npmignore` is a defence-in-depth safety net that
excludes `test/`, `examples/`, `*.config.ts`, `coverage/`, `PLAN.md`.

### 8.6 `biome.json`

Formats + lints. Custom rules:

- Ban `console.*` outside `utils/env.ts` and `adapters/memory/index.ts`.
- Ban `as ` (TypeScript cast) outside `core/algorithm-spec.ts` (union
  narrowing helpers), `adapters/*/index.ts` (raw store return value
  parsing), `utils/base64url.ts` and `utils/hash.ts` (Uint8Array view
  casts).
- Ban dynamic `process.env.*` access outside `utils/env.ts` (Workers /
  Deno safety).
- Ban `setInterval` / `setTimeout` outside `adapters/memory/index.ts`
  (the only place a periodic sweep is reasonable; everywhere else,
  unbounded timers are a leak hazard on edge runtimes).

---

## 9. Edge Cases

The implementation MUST handle the following — each has a dedicated
test in `test/correctness/` or the relevant `test/{core,adapters}/`
file.

### 9.1 Algorithmic edge cases

1. **`cost > capacity`** (token-bucket, leaky-bucket) — return
   `allowed: false` with `retryAfter = window` immediately. The cost
   may be a runtime value (LLM token estimate); throwing here would
   surface as a 5xx for what is genuinely a 429 condition.
2. **`cost === 0`** — treated as a peek; never decrements the
   counter. The public API surface (`peek()`) is the canonical
   path; `check({ cost: 0 })` is permitted for adapter authors but
   not advertised as a primary entrypoint.
3. **Negative or non-finite `cost`** — throws `INVALID_COST` at the
   `check()` call site. This is a programmer error, not a request
   condition.
4. **`limit === 0` at construction** — throws `INVALID_CONFIG` from
   the algorithm factory ("a zero limit blocks every request — use
   `composeAll` with a permissive layer instead").
5. **Sliding-window-counter at the window boundary** — the
   approximation interpolates between the previous and current
   window's counters by the fraction of time elapsed. Worst-case
   overshoot is ~1 % when the previous window was exactly at limit
   and the new one fills instantly; documented in the algorithm's
   TSDoc.
6. **Sliding-window-log set growth** — the log is bounded by `limit`
   per key (we trim on every check). A pathological client that
   sends `cost: 1` repeatedly without checking can never grow the
   log past `limit` because trimming happens before the check.
7. **Token-bucket clock-skew** — the bucket carries `lastRefill`
   timestamps in the store; if the clock moves **backwards** (NTP
   correction) we clamp `elapsed = max(0, now - lastRefill)`. No
   refund of consumed tokens.
8. **Fixed-window 2x burst at boundary** — documented behaviour.
   Tests in `test/correctness/boundary-fairness.test.ts` confirm
   the property; consumers who care about fairness use
   `slidingWindow` instead.
9. **Leaky-bucket `leak === 0`** — throws `INVALID_CONFIG` ("a
   non-leaking bucket fills permanently — did you mean
   `tokenBucket`?").

### 9.2 Key-generation edge cases

1. **Missing `cf-connecting-ip` AND `x-forwarded-for`** — default
   key generator returns `null`, the limiter **skips** rate
   limiting and emits `'rate-limit.skipped'`. We deliberately do
   not bucket against `''` — that would throttle every request
   behind a misconfigured proxy into a single bucket, taking
   down the service. Skipping fails open by design; consumers
   wanting fail-closed pass a custom `keyGenerator` that throws
   on missing IP.
2. **`x-forwarded-for: a, b, c`** — default takes `a` (the first
   hop, closest to the client). Behind multiple trusted proxies
   the consumer overrides `keyGenerator` to skip N hops; the
   number of trusted hops is **never** auto-detected, because
   guessing is the source of the spoofing CVE class
   (`ip-spoofing-via-xff`).
3. **IPv4-mapped IPv6 (`::ffff:1.2.3.4`)** — the default key
   generator normalises to the IPv4 form, so a single client
   appearing on both stacks does not double-bucket.
4. **IPv6 `/64` collapse** — opt-in; off by default. Consumers
   facing IPv6 abuse from the same `/64` (a single household / VPS)
   pass `defaultKeyGenerator({ ipv6Prefix: 64 })`. We don't
   default-on because legitimate large IPv6 networks (mobile
   carriers) would all collapse to one bucket and trip the limit
   for unrelated users.
5. **`keyGenerator` throws** — honours `failOpen` (the same setting
   the store-error path consults, so consumers reason about a single
   degradation switch). With `failOpen: false` (default) the manager
   wraps the cause in `RateLimitError('INVALID_KEY')` and rejects
   the request as `allowed: false` + 429 — failing closed, the
   safe behaviour for fresh deployments. With `failOpen: true` the
   manager swallows the throw, emits `'rate-limit.error'` with the
   wrapped cause, and returns `{ allowed: true, degraded: true }` —
   so a regex bug in a custom extractor cannot DoS 100% of traffic
   the moment it ships. The reviewer's concrete scenario was: a
   late-night deploy regresses the API-key extractor, every
   request throws, and the limiter takes the API down. Honouring
   `failOpen` here turns that outage into an alert.
6. **`keyGenerator` returns a 1 MB string** — checked against
   the configured `maxKeyLength` (default 1024 chars). Over the
   limit: `KEY_TOO_LONG`. Most stores have hard limits (KV
   keys are 512 bytes, Redis keys ~512 MB but realistically <1 KB
   for cache hit rate); the manager's pre-check catches this
   before the network round-trip.

### 9.3 Header edge cases

1. **`headerStyle: 'rfc'`** — emits `RateLimit:
   limit=N, remaining=N, reset=N` and `RateLimit-Policy:
   N;w=N` per draft-ietf-httpapi-ratelimit-headers-10 (which
   uses **structured headers** per RFC 8941 — value-then-params
   syntax, NOT `=` separators). Tests in
   `test/correctness/header-rfc.test.ts` parse with `structured-headers`
   to assert byte parity.
2. **`Retry-After`** — only emitted on 429 (when `allowed: false`),
   per RFC 9110. Value is `Math.ceil(retryAfterMs / 1000)` (rounded
   up to whole seconds) so clients never under-wait.
3. **`headerStyle: 'legacy'`** — `X-RateLimit-Reset` emits **Unix
   seconds**, not milliseconds. We've audited the top 5
   competitors; mixed practice exists and seconds wins.
4. **`Vary` header propagation** — when consumers merge
   `result.headers` into a successful response that varies by
   `Authorization`, the limiter's `RateLimit-*` keys do not
   require `Vary` because they don't change cache identity. We
   document this rather than auto-inserting `Vary: Authorization`,
   which would cache-bust unrelated routes.
5. **Existing `Retry-After` on the response** — when the consumer
   merges via `headers.append`, both values appear and the client
   uses the first per RFC 9110. The `responseBuilder` default
   uses `headers.set` so the limiter's value wins for the 429
   path; success-path merging is the consumer's call.

### 9.4 Storage adapter edge cases

1. **Redis disconnect mid-`consume`** — adapter wraps the underlying
   `ECONNRESET` in `STORE_UNAVAILABLE`; the manager surfaces it (or
   swallows it under `failOpen: true`). We do NOT auto-retry —
   that's middleware's job, not the library's. (A retry loop here
   would silently double-bill on a flapping Redis.)
2. **Redis `EVALSHA NOSCRIPT`** — adapter catches, falls back to
   `EVAL`, and re-caches the SHA. Documented; tested via
   `ioredis-mock` returning the error code.
3. **Cloudflare KV eventual consistency** — reads after a `consume()`
   write may return the old counter for up to 60 s globally. The KV
   adapter README documents this as **best-effort, ≤60 s globally**;
   security-critical / billing-critical deployments use the
   `durable-object` adapter, which is strongly consistent within a
   single object. The README cross-links the two and recommends
   **KV for hot-path caching + DO consulted on every privileged
   action** for hybrid deployments.
4. **KV CAS contention** — the adapter retries up to 3 times on
   `metadata` token mismatch, then returns the best-effort
   counter (the worst-case overshoot is `retries + 1 = 4` per key
   per region, documented).
5. **D1 row-size limit (1 MB)** — the sliding-window-log algorithm
   serialises the timestamp set as JSON; a key with `limit > 50_000`
   approaches the row limit. Adapter throws `PAYLOAD_TOO_LARGE` at
   construction time when `algorithm.kind === 'sliding-window-log'
   && algorithm.limit > 50_000`; consumers use the counter
   approximation or D1-specific raw SQL.
6. **Durable Object hibernation** — DOs hibernate after ~60 s
   idle; the next request wakes them with ~30–80 ms cold-start.
   The adapter keeps no in-memory cache, so hibernation is invisible
   except for latency. Tests assert correctness across a synthetic
   hibernation event.
7. **Memory store on multi-instance Node deployments** — works
   correctly **per process**, not across processes. PM2 cluster
   mode with 4 workers behind one Redis-less limiter would allow
   `4 * limit` per window. The memory adapter README documents
   this as **single-process only**; consumers running multiple
   instances pick Redis / KV / DO instead.
8. **Memory store unbounded growth** — `maxSize` (default 10 000)
   evicts least-recently-used keys. A burst from 100k unique IPs
   would still evict the oldest 90k, but the eviction is cheap
   (O(1) per insert) and bounded by `maxSize`.

### 9.5 Concurrency / race-condition edge cases

1. **N parallel requests on the same key** — Redis adapter is
   atomic via Lua (single-RTT). Memory adapter is atomic via
   single-threaded JS. KV adapter is best-effort (worst-case
   overshoot of 1 documented). DO adapter is atomic via the DO's
   own actor-model serialisation. Tested via
   `test/correctness/concurrency.test.ts` with 1000 parallel
   `check()` calls on the same key against each adapter.
2. **Two limiters sharing one Redis with the same `prefix:scope`**
   — by default `scope` defaults to a stable hash of the
   algorithm spec, so two limiters with different algorithms
   cannot collide. Two limiters with **identical** algorithms +
   prefix DO share state — that's the documented composition
   primitive (e.g. for sharded read-replica reads).
3. **Limiter shared across a long-lived Cloudflare Worker isolate**
   — the limiter handle is `Object.freeze`d and stateless; safe
   to construct once at module top-level. The store handle's
   thread-safety is the store's concern (KV, D1, DO are all
   inherently safe; Redis client safety depends on the chosen
   library — `ioredis` is safe, callers using a custom client
   should verify).
4. **Reset during in-flight `check`** — sequencing within a single
   request is the caller's concern; the manager does not
   serialise across calls. A `reset()` followed by a `check()`
   on the same logical request will see the reset; the manager
   passes `now` through both operations from the same `clock`
   read so they share a time anchor.

### 9.6 Composition edge cases

1. **`composeAll([])` / `composeFirstAllowed([])`** — both throw
   `INVALID_CONFIG` at construction (an empty composition has no
   defined behaviour).
2. **`composeAll([a])` / `composeFirstAllowed([a])`** — equivalent
   to `a` directly, no overhead. Tests assert byte parity for the
   headers.
3. **`composeAll`: layers a, b allow then c blocks** — a and b
   have already **consumed** their permits before c rejects. This
   is the documented logical-AND semantics — for layered quotas
   (per-IP + per-key + per-tenant) it's exactly what consumers
   want. For "any one allow short-circuits" semantics use
   `composeFirstAllowed` instead. Each layer emits its own
   `'rate-limit.allowed'` / `'rate-limit.blocked'` observation,
   so dashboards can attribute consumption to the layer that
   drove it (the README has a recipe for "which layer is hot").
4. **`composeFirstAllowed`: every layer blocks** — return value's
   `state.retryAfter` is the **minimum** across all rejecting
   layers (the most actionable wait for the client). The
   `headers` reflect the layer with that minimum `retryAfter`.
5. **One layer skips, another blocks** — the skip is recorded in
   the observation hook (`type: 'rate-limit.skipped'` for the
   first, then `type: 'rate-limit.blocked'` for the blocking
   layer). The result's `headers` reflect the **blocking** layer
   (so clients see the binding policy in 429), with the skipped
   layer's policy header included alongside if the blocking
   layer used `headerStyle: 'rfc'` or `'both'`.
6. **`tieredRateLimiter` resolver returns an unknown tier with no
   fallback** — the request is **skipped** (returns
   `{ allowed: true }`) and the manager emits a
   `'rate-limit.skipped'` observation tagged with the unknown
   tier name. Ops alert on a non-zero `skipped` rate; this avoids
   turning a resolver/config drift into a production 5xx (the
   prior draft of this plan threw `INVALID_TIER`, which the
   reviewer correctly flagged as a foot-gun). Consumers who
   prefer fail-loud semantics still get them by passing an
   explicit `fallback: throwingLimiter`.
7. **`ruledRateLimiter` rule predicates throw** — bubbled as
   `RateLimitError('INVALID_CONFIG', 'rule predicate threw', { cause })`;
   the request is rejected (treated as 429), not allowed
   through. Predicates are not user-input territory.

### 9.7 Framework adapter edge cases

1. **Hono + Workers + KV** — the adapter detects `c.executionCtx`
   and switches the limiter's `hookMode` to `'wait-until'`,
   wrapping the observability hook in
   `c.executionCtx.waitUntil(hook(event))`. The bare middleware
   path on Workers/Vercel Edge has no access to `executionCtx`,
   so it stays on the default `'fire-and-forget'` mode (see §5.4)
   — adding the hook's latency to TTFB on every request would
   defeat the point of edge deployment. Documented in the Hono
   adapter's README.
2. **Express request without `req.headers`** — extremely old
   Express forks (≤3.x) may not populate; the adapter falls
   back to `IncomingMessage.rawHeaders`. Documented as best-effort
   and gated behind `expressRateLimit(limiter, { legacy: true })`.
3. **Next.js middleware `NextResponse` cookie/header
   precedence** — the adapter uses `NextResponse.rewrite` to
   short-circuit when `allowed: false`, so the user's matcher is
   honoured but downstream handlers don't run.
4. **Fastify hook order** — registered as `onRequest` so the
   limiter runs before parsers. Documented; tests cover order
   via `fastify.inject`.
5. **SvelteKit `event.fetch`** (server-side fetch) is a `Request`
   too. Consumers passing it to the limiter will rate limit
   their **own** server-side fetches — counter-intuitive. The
   `rateLimitHandle` adapter docs warn against this and the
   `keyGenerator` default returns `null` for requests without a
   client IP, so the worst case is "skipped".

### 9.8 Time / clock edge cases

1. **Clock moves backwards** (NTP correction, suspended
   container resuming with stale clock). Token-bucket /
   leaky-bucket clamp `elapsed = max(0, now - lastRefill)`.
   Sliding-window-log discards entries with timestamps **in the
   future** beyond a small skew tolerance (60 s default), so
   a brief backward jump cannot poison the log permanently.
2. **`Date.now` granularity on Cloudflare Workers** — coarsened
   to ~1 ms during I/O suspension to mitigate Spectre. Sliding
   window + token bucket are robust to ~1 ms granularity; the
   `slidingWindowLog` algorithm with a `window` < 100 ms is
   unlikely to be useful on Workers and the docs warn.
3. **Custom `clock` returning a non-monotonic value** — the
   limiter does not check; the responsibility is the consumer's
   (similar to passing a broken `keyGenerator`).
4. **`config.clock` throws** — wrapped in
   `RateLimitError('STORE_UNAVAILABLE', 'clock threw', { cause })`
   because a broken clock makes the consume operation
   non-deterministic; honoured by `failOpen` like a store error.

### 9.9 Response-building edge cases

1. **`responseBuilder` throws** — fall through to the default
   plain-text 429; emit `'rate-limit.error'` with the cause. We
   do not let a broken builder turn a 429 into a 5xx.
2. **`responseBuilder` returns a non-`Response`** — wrapped in
   `new Response(value, { status: 429 })` if it's a string,
   else thrown as `INVALID_CONFIG`. Documented; tests assert
   the wrapping path.
3. **Custom `responseBuilder` for streaming** — the builder may
   return a `Response` with a streaming body. The limiter does
   not read the body, so Workers' `ReadableStream` is fine.

---

## 10. Out of Scope (1.0)

Explicitly **not** addressed by `@devkit/ratelimit` — to keep scope
tight and the bundle small. Each is either a separate library in
the same namespace or a problem we deliberately don't take on.

- **Bot detection / signal-based scoring.** `@devkit/ratelimit` does
  not interpret User-Agent or behavioural signals. Consumers
  combine us with `@arcjet/sdk`, Cloudflare Bot Management, or a
  feature-flag gate.
- **Distributed coordination across regions with sub-second
  consistency.** That is the storage backend's job. We document
  per-adapter consistency guarantees and let users pick. Anyone
  wanting strong global consistency uses Durable Objects (a single
  region per key) or a global Redis (e.g. Aiven, Vercel KV,
  Cloudflare's Hyperdrive).
- **Custom Lua-script extensibility.** Consumers wanting their own
  algorithm pass a custom `RateLimitStore`; we don't ship a script
  loader because the security-review surface (script injection)
  exceeds the value.
- **A UI / dashboard for live limits.** We expose the
  `RateLimitObservation` hook; rendering is the consumer's call.
  A reference React panel will live in `examples/`, not in the
  library.
- **Auto-detection of CDN / proxy hop count.** Documented as a
  spoofing CVE class; consumers configure trusted hops explicitly.
- **CAPTCHA / proof-of-work integration.** Slated for a sibling
  `@devkit/challenge` lib; the rate limiter exposes
  `'rate-limit.blocked'` events you can plug into one.
- **Quota persistence across deploys when using the memory
  adapter.** The memory adapter is process-scoped by design;
  consumers wanting persistence pick Redis / KV / D1.
- **Soft limits / warnings without blocking.** Consumers compose
  two limiters at different limits and inspect the lower one's
  state — there's nothing the engine should special-case.
- **Built-in metrics exporter (Prometheus / OpenTelemetry).** The
  observability hook is the integration point; we don't take a
  dependency on either ecosystem.

---

## Review Changes

This section records every point Vasyl Bruhanda raised in the PR #1
architecture review and what was changed (or, for the one item I
disagreed with, why I held the line). Sections of the plan that moved
are noted in parentheses.

### MAJOR

- **DX gap vs `@upstash/ratelimit` — three imports for the minimum
  useful limiter.** **Agreed.** Added a sugar overload of
  `createRateLimiter` that accepts a flat `RateLimitFlatConfig` with
  `algorithm` as a string discriminator (`'sliding-window'`,
  `'token-bucket'`, etc.) and the algorithm's tuning fields inline,
  so the minimum useful limiter is now two imports
  (`createRateLimiter` + the chosen store). The core engine inlines a
  ~150 B normaliser table over the five algorithms; spec form (with
  algorithm subpath import) remains available and trims those
  normalisers out for size-sensitive builds. Documented in the §2.1
  docblock + a "two forms" callout, and demonstrated in the §2.10
  example. Bumped core size budget from 3.0 KB → 3.2 KB (PLAN.md
  §2.1, §2.10, §6.1; package.json `size-limit.core`).

- **`failOpen` typing inconsistent across the doc — declared as
  `boolean` but described as `'closed'` / `'open'`; peek "always
  throws" contradicted the spirit of `failOpen`.** **Agreed.**
  Rewrote the `failOpen` docblock to use boolean-only language
  (false = fail-closed, true = fail-open with `degraded: true` on
  the result). Made `peek()` honour `failOpen` symmetrically with
  `check()` — when fail-open and the store is unreachable, peek
  returns `{ allowed: true, degraded: true }` carrying the
  last-known state (zero values when no prior observation exists).
  Quota-display widgets that consult the limiter on every page
  render no longer surface infrastructure flapping as 5xx. Added
  a `degraded: boolean` field to `RateLimitResult` for both
  fail-open paths. Updated §5.1 error-table rows to reflect the
  new behaviour. (PLAN.md §2.2, §2.3, §2.5, §5.1.)

- **`RateLimiter` is not generic but docs claim it is via
  `@typeParam K`.** **Agreed.** Threaded `K` through
  `RateLimiter<K>`, `RateLimitConfig<K>`, `RateLimitResult<K>`,
  `KeyGenerator<K>`, `RateLimitObservation<K>`, and
  `RateLimitHook<K>`. Updated `KeyGenerator` to accept either a
  bare string or a structured `{ key, context: K }` payload — the
  latter flows through to `result.context` typed as `K`. Made the
  framework adapter signatures (Hono, Express, Next) explicitly
  generic so `c.var.rateLimit.context.tenantId` is typed end-to-end
  in the §2.10 Hono example. (PLAN.md §2.1, §2.2, §2.3, §2.5,
  §2.8, §2.10.)

- **`@cloudflare/workers-types` leaks via published `.d.ts` but
  isn't a peer dep.** **Agreed.** Moved
  `@cloudflare/workers-types` from devDep-only to an optional peer
  dep (`>=4.20240925 <5`) so consumers installing
  `adapters/cloudflare-kv` / `cloudflare-d1` / `durable-object`
  get `KVNamespace`, `D1Database`, `DurableObjectNamespace` from
  the same source Wrangler does. `peerDependenciesMeta` keeps it
  silent for non-Workers installs. Added a top-of-§2.7 callout
  block and updated the §7.2 peer-dep table. (PLAN.md §2.7, §7.2;
  package.json `peerDependencies`, `peerDependenciesMeta`.)

### MEDIUM

- **`Duration` template type does not reject `'1.5h'` at compile
  time — `${number}` accepts decimals, signs, NaN.** **Agreed.**
  Switched the template literal from `${number}` to `${bigint}`,
  which TS uses to enforce non-negative integer literals. `'1.5h'`,
  `'-1m'`, `'NaN s'`, `'1 minute'` are now genuine compile-time
  errors at the call site. Rewrote §4.4 to describe what `${bigint}`
  delivers (no decimals/signs) and noted that the runtime parser in
  `core/duration.ts` re-validates with a regex as a defence-in-depth
  check for non-literal strings. (PLAN.md §2.5 `Duration` export,
  §4.4.)

- **`composeRateLimiters` consumes preceding layers' quota silently
  — needs to be loud in the doc and in the type.** **Agreed.**
  Renamed to `composeAll` (mirrors logical AND) and added a peer
  `composeFirstAllowed` that short-circuits on the first allow
  without consuming the rest (logical OR). The `composeAll` docblock
  spells out the consume-on-allow side-effect prominently and notes
  that each layer emits its own observation. `composeFirstAllowed`'s
  all-blocked branch returns the layer with the soonest `retryAfter`
  so clients get the most actionable wait. Updated §2.10 example
  and §9.6 edge-case rules. (PLAN.md §2.9, §2.10, §9.6.)

- **Observability hook awaits block the response on non-Hono
  runtimes.** **Agreed.** Changed the default `hookMode` to
  `'fire-and-forget'` (the manager schedules the hook via
  `queueMicrotask` and never awaits). Added a `hookMode` config
  option with three values: `'fire-and-forget'` (default),
  `'sync'` (bounded by `hookTimeoutMs` — for tests + long-lived
  Node), and `'wait-until'` (opt-in for framework adapters that
  own `executionCtx`). The Hono / SvelteKit adapters auto-detect
  `executionCtx` and switch to `'wait-until'`; the bare
  Workers/Vercel Edge middleware path stays on fire-and-forget so
  it never adds the hook's latency to TTFB. (PLAN.md §2.5 `hookMode`
  + `hookTimeoutMs`, §5.4, §9.7 item 1.)

- **`keyGenerator` throwing → reject means a buggy extractor DoS's
  the API.** **Agreed.** Made the keyGenerator-throws path honour
  `failOpen` symmetrically with the store-error path, so a regex
  bug in a custom extractor cannot DoS 100% of traffic. With
  `failOpen: true` the manager swallows the throw, emits
  `'rate-limit.error'` with the cause, and returns
  `{ allowed: true, degraded: true }`. With `failOpen: false`
  (default) the previous reject behaviour stands. Updated §5.1
  table and rewrote §9.2 item 5. (PLAN.md §2.5 `failOpen` doc,
  §5.1, §9.2 item 5.)

- **`AlgorithmSpec` is exported with raw fields, bypassing factory
  validation.** **Agreed.** Branded each variant of `AlgorithmSpec`
  via a non-exported `AlgorithmBrand` symbol so only the algorithm
  factories (and the sugar overload's internal mint helper) can
  construct values. Adapter authors who type their parameters as
  `AlgorithmSpec` keep working (the type is read-assignable for
  pattern-matching), but a consumer can no longer write
  `{ kind: 'token-bucket', capacity: -1, ... } as AlgorithmSpec`
  to bypass bounds checks. Test fixtures get an `@internal`
  helper from `@devkit/ratelimit/testing` (separate subpath, not
  in the published surface). (PLAN.md §4.1.)

### LOW

- **Inconsistent factory naming (`createRateLimiter` vs
  `slidingWindow` vs `honoRateLimit`).** **Disagreed; held the
  line.** The reviewer's suggestion (bare nouns everywhere:
  `rateLimiter()`, `memoryStore()`, `honoRateLimit()`) saves ~5
  chars per call site, but the current convention encodes useful
  semantics: `createX` for runtime handles (limiters and stores
  — the JS standard-library convention from `createServer`,
  `createElement`, `createConnection`); bare nouns for **data
  factories** (algorithm specs, which return frozen plain
  objects, not handles); verb-noun for framework adapters
  (`honoRateLimit`, `expressRateLimit` — these *do* an action,
  applying rate limiting to a framework's request lifecycle).
  Bare-noun `rateLimiter()` would also collide ergonomically with
  the imported `RateLimiter` type for users who like to alias.
  I'll add the rationale to the README's "API conventions"
  section so contributors know which bucket a new factory
  belongs to, but I'd rather keep the three-bucket convention
  intentional than chase line-length parity.

- **`RateLimitObservation` is missing request context (`path`,
  `method`).** **Agreed.** Added `path: string`, `method: string`,
  `request: Request`, and `context: K` (when the structured key
  generator was used) to `RateLimitObservation`. Per-route
  Prometheus labels are now possible without consumers re-deriving
  from the key. (PLAN.md §2.5 `RateLimitObservation` interface.)

- **`crypto.getRandomValues` is listed in the intro but never
  referenced.** **Agreed.** Removed it from the intro and replaced
  the slot with `Date.now`, which is genuinely used by every
  algorithm via the `core/time.ts` indirection. (PLAN.md intro
  paragraph.)

- **`tieredRateLimiter` throws `INVALID_TIER` on unknown tier — a
  drift between resolver and tier table becomes a 5xx in
  production.** **Agreed.** Changed the unknown-tier-with-no-fallback
  behaviour from "throw `INVALID_TIER`" to "skip the request +
  emit a `'rate-limit.skipped'` observation tagged with the
  unknown tier name". Ops teams alert on a non-zero `skipped`
  rate; the API doesn't 5xx on a config drift. Consumers who
  prefer fail-loud semantics can still get them by passing
  `fallback: someThrowingLimiter`. Updated §2.9 docblock, §5.1
  table row, and §9.6 item 6. (PLAN.md §2.9, §5.1, §9.6.)
