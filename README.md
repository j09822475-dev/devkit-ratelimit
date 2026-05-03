# @devkit/ratelimit

[![npm version](https://img.shields.io/npm/v/@devkit/ratelimit.svg?style=flat-square)](https://www.npmjs.com/package/@devkit/ratelimit)
[![bundle size](https://img.shields.io/bundlephobia/minzip/@devkit/ratelimit?style=flat-square&label=core%20gzip)](https://bundlephobia.com/package/@devkit/ratelimit)
[![license](https://img.shields.io/npm/l/@devkit/ratelimit.svg?style=flat-square)](./LICENSE)
[![types: TypeScript](https://img.shields.io/badge/types-TypeScript-3178c6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)

Universal, zero-dependency rate limiter built on the Web-Standard `Request` / `Response` API — one library, every runtime.

The JS rate-limit ecosystem is fragmented: `express-rate-limit` only runs in Express, `rate-limiter-flexible` needs Node-specific APIs (no Workers / Deno / Bun edge), `@upstash/ratelimit` requires a paid Upstash account. With edge runtimes everywhere, you need a limiter that runs anywhere, against any storage backend, with no vendor lock-in. `@devkit/ratelimit` is that library: a ~3 KB core that takes a `Request` and returns a `Response`, with pluggable algorithms, pluggable stores, and thin framework adapters that ship as separate subpath exports so you only pay for what you import.

## Features

- **Runs everywhere** — Node 20+, Bun, Deno, Cloudflare Workers, Vercel Edge, Netlify Edge. Nothing Node-specific in core.
- **Five algorithms** — sliding-window counter, sliding-window log, token bucket, fixed window, leaky bucket.
- **Six storage adapters** — in-process LRU memory, Redis (Lua-atomic), Upstash REST, Cloudflare KV (best-effort), Cloudflare D1 (CAS-serialised), Durable Objects (strong consistency).
- **Six framework adapters** — Hono, Elysia, Express, Fastify, Next.js (App Router), SvelteKit. All optional subpaths.
- **RFC-compliant headers** — emits `RateLimit` / `RateLimit-Policy` per `draft-ietf-httpapi-ratelimit-headers-10` (RFC 8941 structured headers), plus legacy `X-RateLimit-*` for older clients.
- **Composition** — `composeAll` (AND), `composeFirstAllowed` (OR), `tieredRateLimiter` (free/pro/enterprise), `ruledRateLimiter` (per-route).
- **Zero runtime dependencies.** Core is ~3 KB gzipped; each adapter ≤ 2 KB; tree-shake-friendly subpath exports.
- **Strict TypeScript** — branded algorithm specs prevent unsafe casts; structured key generators thread a typed `context` through to result objects and observability hooks.
- **Observability hooks** — single typed event for allowed / blocked / skipped / error, with three execution modes (`fire-and-forget` / `sync` / `wait-until`).
- **Fail-open or fail-closed** — pick one knob to control what happens when the store is unreachable.

## Install

```sh
npm install @devkit/ratelimit
```

Optional peer dependencies are pulled in only for the adapters you use (Redis client, `@upstash/redis`, `@cloudflare/workers-types`, your framework of choice).

## Quick start

```ts
import { createRateLimiter } from '@devkit/ratelimit';
import { createMemoryStore } from '@devkit/ratelimit/adapters/memory';

const limiter = createRateLimiter({
  algorithm: 'sliding-window',
  limit: 100,
  window: '1m',
  store: createMemoryStore(),
});

export default {
  async fetch(req: Request): Promise<Response> {
    const { allowed, headers } = await limiter.check(req);
    if (!allowed) return new Response('Too Many Requests', { status: 429, headers });
    return new Response('ok', { headers });
  },
};
```

That's it — the same handler runs in Workers, Deno, Bun, or Node `node --experimental-strip-types`.

## API reference

### Core

#### `createRateLimiter(config) → RateLimiter`

The central factory. Two construction forms share one implementation: a flat **sugar form** (`algorithm: 'sliding-window'`, fields inline) and a **spec form** (`algorithm: slidingWindow({ ... })`). Both produce a frozen `RateLimiter` handle.

```ts
import { createRateLimiter } from '@devkit/ratelimit';
import { tokenBucket } from '@devkit/ratelimit/algorithms/token-bucket';
import { createRedisStore } from '@devkit/ratelimit/adapters/redis';
import Redis from 'ioredis';

// Sugar form
const a = createRateLimiter({
  algorithm: 'token-bucket',
  capacity: 50,
  refill: 5,
  interval: '1s',
  store: createRedisStore(new Redis(process.env.REDIS_URL!)),
});

// Spec form (equivalent)
const b = createRateLimiter({
  algorithm: tokenBucket({ capacity: 50, refill: 5, interval: '1s' }),
  store: createRedisStore(new Redis(process.env.REDIS_URL!)),
});
```

The returned `RateLimiter` exposes:

| Method | Signature | Description |
|---|---|---|
| `check(req, opts?)` | `(Request, { cost?: number }) → Promise<RateLimitResult>` | Atomically consume one (or `cost`) permit(s). |
| `peek(req)` | `(Request) → Promise<RateLimitResult>` | Inspect current state without consuming. |
| `reset(req)` | `(Request) → Promise<boolean>` | Reset the bucket for the request's key. |
| `resetKey(key)` | `(string) → Promise<boolean>` | Reset by an explicit user key. |
| `middleware()` | `() → (Request) → Promise<Response \| undefined>` | Web-Standard middleware — `Response` (429) when blocked, `undefined` when allowed. |
| `withExecutionCtx(ctx)` | `({ waitUntil }) → RateLimiter` | Cheap per-request clone for `hookMode: 'wait-until'`. |
| `config` | `Readonly<NormalisedRateLimitConfig>` | Frozen, defaulted view of construction config. |

`RateLimitResult` shape:

```ts
{
  allowed: boolean;
  key: string;
  state: { limit: number; remaining: number; reset: number; retryAfter: number };
  headers: Headers;            // Pre-filled per `headerStyle`
  degraded: boolean;           // true under fail-open infrastructure errors
  context: K;                  // Caller-defined payload from structured key generators
}
```

#### `defaultKeyGenerator` / `defaultKeyGeneratorWith(opts)`

Default extractor — inspects `cf-connecting-ip`, then `x-real-ip`, then the first hop of `x-forwarded-for`. Returns `null` when none are present (so the limiter skips rather than funnelling every request behind a misconfigured proxy into a single bucket). `defaultKeyGeneratorWith({ ipv6Prefix: 64 })` collapses IPv6 addresses to their leading prefix.

```ts
import { defaultKeyGeneratorWith } from '@devkit/ratelimit';

const limiter = createRateLimiter({
  algorithm: 'sliding-window', limit: 100, window: '1m',
  store: createMemoryStore(),
  keyGenerator: defaultKeyGeneratorWith({ ipv6Prefix: 64 }),
});
```

Custom generators may return:
- a bare `string` — the bucketing key,
- `null` / `undefined` / `''` — skip rate limiting for this request,
- `{ key, context }` — a structured payload threading `context` of type `K` through the result.

#### `composeKey(prefix, scope, userKey) → string`

Build a fully-qualified store key (`prefix:scope:userKey`). Empty `prefix` or `scope` collapses cleanly. Useful for pre-warming buckets from a job runner.

#### `parseDuration(value) → number`

Parse a `Duration` (`number` ms, template-literal `'1m'`, or object `{ minutes: 1.5 }`) into integer milliseconds. Defence-in-depth: the runtime regex re-validates strings even though the template-literal type already rejects decimals.

#### `RateLimitError`

The single error class the public API throws. Carries a stable `code` (`'INVALID_CONFIG' | 'INVALID_COST' | 'INVALID_KEY' | 'INVALID_TIER' | 'STORE_UNAVAILABLE' | 'WINDOW_TOO_LARGE' | 'PAYLOAD_TOO_LARGE' | 'KEY_TOO_LONG'`) and an optional `cause`.

`RateLimitError.is(value)` is a cross-realm-safe type guard — use it instead of `instanceof` when the error may have crossed a Worker ↔ Durable Object boundary.

```ts
try {
  await limiter.check(req);
} catch (err) {
  if (RateLimitError.is(err) && err.code === 'STORE_UNAVAILABLE') {
    // route to fallback store or fail open
  }
  throw err;
}
```

### Algorithms

Each algorithm is an independent subpath export; importing one does not pull the others. All factories validate their inputs at construction time and return a branded `AlgorithmSpec`.

#### `slidingWindow({ limit, window })` — `@devkit/ratelimit/algorithms/sliding-window`

Sliding-window counter. Approximates a true sliding window by interpolating between two adjacent fixed windows; worst-case ~1% overshoot. Two integer counters per key. **The right default for 99% of API rate limiting.**

```ts
const spec = slidingWindow({ limit: 100, window: '1m' });
```

#### `slidingWindowLog({ limit, window })` — `@devkit/ratelimit/algorithms/sliding-window-log`

Exact bound, no approximation. Stores per-key timestamps and counts those within the window on each check. O(limit) memory per key vs the counter's O(1). Pick this when accuracy matters more than memory cost (billing-critical, compliance-driven).

#### `tokenBucket({ capacity, refill, interval })` — `@devkit/ratelimit/algorithms/token-bucket`

`capacity` tokens, refilled at `refill` per `interval`. The canonical "burst-friendly" algorithm: a client can spend `capacity` tokens immediately, then is throttled to the steady refill rate. **Use for AI / LLM endpoints where short bursts are fine but sustained abuse is not.**

```ts
const spec = tokenBucket({ capacity: 50, refill: 5, interval: '1s' });
```

#### `fixedWindow({ limit, window })` — `@devkit/ratelimit/algorithms/fixed-window`

`limit` permits per aligned wall-clock window. Cheapest to implement (a single atomic `INCR + EXPIRE` in Redis) but allows up to 2N requests across a window boundary. Pick when you have hard memory constraints.

#### `leakyBucket({ capacity, leak, interval })` — `@devkit/ratelimit/algorithms/leaky-bucket`

`capacity` slots, drained at `leak` per `interval`. Smooths outbound traffic to a constant rate; bursts are conceptually queued rather than admitted at full speed. Use for outbound webhook delivery or downstream-API protection. `leak` MUST be `> 0` (a non-leaking bucket fills permanently — that's a bug, not a feature).

### Storage adapters

#### `createMemoryStore(opts?)` — `@devkit/ratelimit/adapters/memory`

In-process LRU. Single-process JS guarantees every operation is atomic by construction. `maxSize` (default 10 000) caps memory; `sweepIntervalMs` (default 30 s, `0` to disable) periodically drops decayed entries. Pick for dev / single-instance deploys.

```ts
const store = createMemoryStore({ maxSize: 50_000 });
```

#### `createRedisStore(client, opts?)` — `@devkit/ratelimit/adapters/redis`

Redis-backed, uses Lua `EVAL` for single-RTT atomic check-and-decrement. Scripts are loaded once with `SCRIPT LOAD` and cached by SHA so subsequent calls go through `EVALSHA`. Works with `ioredis`, `redis@^4`, or any client matching the narrow `RedisLike` shape.

```ts
import Redis from 'ioredis';
const store = createRedisStore(new Redis(process.env.REDIS_URL!));
```

#### `createUpstashStore(client, opts?)` — `@devkit/ratelimit/adapters/upstash`

Same Lua scripts as the Redis adapter, executed via Upstash's `eval` REST primitive. One HTTP round-trip per check.

```ts
import { Redis } from '@upstash/redis';
const store = createUpstashStore(Redis.fromEnv());
```

#### `createKVStore(kv, opts?)` — `@devkit/ratelimit/adapters/cloudflare-kv`

Cloudflare KV. Eventually consistent (≤ 60 s global staleness). KV exposes no CAS primitive, so this is best-effort `get → mutate → put` with a bounded retry loop on transport errors only. Two concurrent consumes from the same colocation can both read level N and both write level N+1; under heavy contention worst-case overshoot is `concurrentRequests` per region. **Use only when "approximately N per minute, somewhere in the world" is acceptable.** For billing- or security-critical quotas, use Durable Objects instead.

#### `createD1Store(db, opts?)` — `@devkit/ratelimit/adapters/cloudflare-d1`

Cloudflare D1. Strong consistency within a single D1 region via an optimistic-concurrency cycle (SELECT current row, compute post-state in JS, UPSERT with a `WHERE updated_at = ? AND data = ?` guard). Bounded retry on lost-race; throws `STORE_UNAVAILABLE` after exhausting retries. Run the bundled schema once with `wrangler d1 execute` before first deploy.

#### `createDurableObjectStore(namespace, opts?)` — `@devkit/ratelimit/adapters/durable-object`

Cloudflare Durable Objects. **Strong consistency** within a single object: each rate-limit key resolves to a single DO instance via `idFromName(prefix:scope:key)`, so all RPCs to that key go to the same isolate and serialise naturally. The bundled `RateLimitDurableObject` class must be re-exported from your worker for Wrangler to bind it.

```ts
export { RateLimitDurableObject } from '@devkit/ratelimit/adapters/durable-object';
```

### Composition

Subpath: `@devkit/ratelimit/compose`.

#### `composeAll(limiters)`

Logical AND. Runs every limiter in order; the first to block wins. **Side-effect:** prior layers have already consumed their permit by the time a later layer blocks — the correct semantics for layered quotas (per-IP + per-key + per-tenant).

```ts
import { composeAll } from '@devkit/ratelimit/compose';
const guard = composeAll([ipLimiter, keyLimiter, tenantLimiter]);
```

#### `composeFirstAllowed(limiters)`

Logical OR with short-circuit on the first allow. Subsequent layers do **not** consume their permits. Useful for "either an authenticated key OR a generous IP allowance must permit this".

#### `tieredRateLimiter({ resolve, tiers, fallback? })`

Picks one limiter per request via a resolver (e.g. by API plan). Unknown tier without a fallback skips the request (fail-soft) — turning a resolver/config drift into a 5xx is the worse production-time foot-gun.

```ts
const limiter = tieredRateLimiter({
  resolve: (req) => planFromHeader(req),
  tiers: { free: freeLimiter, pro: proLimiter, enterprise: enterpriseLimiter },
  fallback: anonymousLimiter,
});
```

#### `ruledRateLimiter({ rules, fallback? })`

First-matching-rule wins. Predicates are evaluated top-down; a throwing predicate bubbles as `INVALID_CONFIG`.

```ts
const limiter = ruledRateLimiter({
  rules: [
    { when: (r) => r.method === 'POST', use: writeLimiter },
    { when: (r) => new URL(r.url).pathname.startsWith('/admin'), use: adminLimiter },
  ],
  fallback: defaultLimiter,
});
```

## Framework guides

All framework adapters are subpath exports — importing one does not load any other.

### Hono

```ts
import { Hono } from 'hono';
import { createRateLimiter } from '@devkit/ratelimit';
import { createMemoryStore } from '@devkit/ratelimit/adapters/memory';
import { honoRateLimit } from '@devkit/ratelimit/frameworks/hono';

const limiter = createRateLimiter({
  algorithm: 'sliding-window',
  limit: 100,
  window: '1m',
  store: createMemoryStore(),
  hookMode: 'wait-until', // observability runs through executionCtx.waitUntil
});

const app = new Hono();
app.use('*', honoRateLimit(limiter));
app.get('/', (c) => c.text('ok'));

export default app;
```

The middleware exposes the result on `c.var.rateLimit`, merges the limiter's headers into the downstream response, and rebinds the limiter via `withExecutionCtx` per request when `c.executionCtx` is available.

### Express

```ts
import express from 'express';
import { createRateLimiter } from '@devkit/ratelimit';
import { createRedisStore } from '@devkit/ratelimit/adapters/redis';
import { expressRateLimit } from '@devkit/ratelimit/frameworks/express';
import Redis from 'ioredis';

const limiter = createRateLimiter({
  algorithm: 'token-bucket',
  capacity: 50, refill: 5, interval: '1s',
  store: createRedisStore(new Redis(process.env.REDIS_URL!)),
});

const app = express();
app.use(expressRateLimit(limiter));
app.get('/', (_req, res) => res.send('ok'));
app.listen(3000);
```

The Express shim translates `(req, res, next)` to a Web-Standard `Request` so the limiter has no Node-specific code path.

### Next.js (App Router)

Per-route handler wrap:

```ts
// app/api/hello/route.ts
import { createRateLimiter } from '@devkit/ratelimit';
import { createMemoryStore } from '@devkit/ratelimit/adapters/memory';
import { withRateLimit } from '@devkit/ratelimit/frameworks/next';

const limiter = createRateLimiter({
  algorithm: 'sliding-window', limit: 100, window: '1m',
  store: createMemoryStore(),
});

export const GET = withRateLimit(limiter, async () =>
  Response.json({ ok: true }),
);
```

Or as edge middleware:

```ts
// middleware.ts
import { rateLimitMiddleware } from '@devkit/ratelimit/frameworks/next';
export const config = { matcher: '/api/:path*' };
export default rateLimitMiddleware(limiter);
```

### Other frameworks

The same pattern applies to **Elysia** (`elysiaRateLimit`), **Fastify** (`fastifyRateLimit`), and **SvelteKit** (`rateLimitHandle`). Each lives behind its own subpath export — see the source for one-line examples.

If your framework isn't covered, the core is already a `(req: Request) => Promise<RateLimitResult>` — wire it up directly with `limiter.middleware()`.

## Configuration

`createRateLimiter(config)` accepts the following options:

| Option | Type | Default | Description |
|---|---|---|---|
| `algorithm` | `AlgorithmSpec \| string` | — | **Required.** Sugar (`'sliding-window'`) or spec form (`slidingWindow({ ... })`). |
| `store` | `RateLimitStore` | — | **Required.** Storage adapter. |
| `keyGenerator` | `(req, ctx) => string \| null \| StructuredKey<K>` | `defaultKeyGenerator` | Bucketing key. Return `null` to skip. |
| `prefix` | `string` | `'rl'` | Prepended to every store key. |
| `scope` | `string` | hash of algorithm spec | Logical scope, prevents cross-policy collision. |
| `headerStyle` | `'rfc' \| 'legacy' \| 'both' \| 'none'` | `'rfc'` | Response-header dialect. |
| `responseBuilder` | `(info) => Response \| Promise<Response>` | plain-text 429 | Used by `middleware()` on block. |
| `message` | `string` | `'Too Many Requests'` | Body for the default 429. |
| `failOpen` | `boolean` | `false` | `true` swallows store errors; result carries `degraded: true`. |
| `cost` | `number` | `1` | Default permits per `check()` call (overridable per-call). |
| `on` | `(event) => void \| Promise<void>` | — | Observability hook. |
| `hookMode` | `'fire-and-forget' \| 'sync' \| 'wait-until'` | `'fire-and-forget'` | How the hook is invoked. |
| `hookTimeoutMs` | `number` | `50` | Bound on `'sync'` hook duration. |
| `clock` | `() => number` | `Date.now` | Override the wall clock (tests, deterministic replays). |
| `maxKeyLength` | `number` | `1024` | Over the limit produces `KEY_TOO_LONG`. |
| `executionCtx` | `{ waitUntil(p): void }` | — | For `hookMode: 'wait-until'` outside framework adapters. |

### Header styles

- `'rfc'` (default) — `RateLimit` and `RateLimit-Policy` per `draft-ietf-httpapi-ratelimit-headers-10` (RFC 8941 structured fields).
- `'legacy'` — `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset` (Unix seconds).
- `'both'` — emit both for mixed-client compatibility.
- `'none'` — emit nothing; build them yourself from `result.state`.

`Retry-After` is added automatically when `state.retryAfter > 0`, per RFC 9110.

### Observability

```ts
const limiter = createRateLimiter({
  algorithm: 'sliding-window', limit: 100, window: '1m',
  store: createMemoryStore(),
  on: (e) => {
    metrics.increment(`ratelimit.${e.type.split('.')[1]}`, {
      algorithm: e.algorithm.kind,
      path: e.path,
      method: e.method,
    });
  },
  hookMode: 'wait-until', // bind via withExecutionCtx in your framework adapter
});
```

The hook receives a single discriminated event with `type ∈ { 'rate-limit.allowed', 'rate-limit.blocked', 'rate-limit.skipped', 'rate-limit.error' }`, plus `state`, `algorithm`, `cost`, `startedAt`, `elapsedMs`, `method`, `path`, `request`, `context`, and (on errors) the wrapped `error`.

## TypeScript features

- **Branded algorithm specs** — `AlgorithmSpec` carries a non-exported brand symbol, so a consumer cannot construct one with `as AlgorithmSpec` and bypass the factory's bounds checks. Only the algorithm factories produce branded values.
- **Template-literal `Duration`** — `'1m'`, `'500 ms'`, `'1 h'` are typed as `` `${bigint}${' ' | ''}${'ms'|'s'|...}` ``, so decimals, signs, exponents, and `NaN` are TypeScript errors at the call site (with a runtime regex as defence-in-depth).
- **Typed structured key context** — when your `keyGenerator` returns `{ key, context: { tenant: 'acme', plan: 'pro' } }`, the result's `result.context` is inferred as that exact shape, propagated through `RateLimitResult<K>` and observability events.
- **Two construction forms, one return type** — both sugar (`algorithm: 'sliding-window'`) and spec (`algorithm: slidingWindow({ ... })`) overloads collapse to the same `RateLimiter<K>`, with full inference for `K`.
- **Stable error codes** — `RateLimitErrorCode` is a string-literal union, so `switch (err.code)` is exhaustively type-checked.
- **Cross-realm `RateLimitError.is`** — survives Workers ↔ Durable Object structured cloning where `instanceof` doesn't.

## Comparison vs competitors

| Capability | `@devkit/ratelimit` | `express-rate-limit` | `rate-limiter-flexible` | `@upstash/ratelimit` | `hono-rate-limiter` |
|---|---|---|---|---|---|
| Web-Standard `Request` core | ✅ | ❌ Express only | ❌ Node only | ✅ | ❌ Hono only |
| Cloudflare Workers | ✅ | ❌ | ❌ | ✅ | ✅ |
| Vercel Edge | ✅ | ❌ | ❌ | ✅ | ✅ |
| Deno / Bun | ✅ | partial | ❌ | ✅ | ✅ |
| Algorithms | sliding (counter + log), token, fixed, leaky | fixed | sliding, token, leaky, fixed | sliding, fixed, token | fixed |
| Pluggable stores | memory, Redis, Upstash, KV, D1, DO | Redis, Memcached, Mongo, … | Redis, Mongo, MySQL, memory, cluster | **Upstash only** | memory + custom |
| Vendor lock-in | none | none | none | **Upstash account required** | none |
| Composition primitives | AND, OR, tiered, ruled | ❌ | ❌ | ❌ | ❌ |
| RFC `RateLimit-Policy` headers | ✅ | partial | ❌ | partial | ❌ |
| Bundle size (core, gz) | ~3 KB | ~7 KB | ~50 KB+ | ~5 KB | ~2 KB (Hono-bound) |
| Runtime dependencies | **0** | several | several | `@upstash/redis` | 0 |
| TypeScript-first | ✅ branded types | partial | partial | ✅ | ✅ |

(Numbers from the [`08-rate-limiter-universal` market study](../../github-portfolio/reports/08-rate-limiter-universal.json) — `express-rate-limit` ~2.5 M weekly DLs, `rate-limiter-flexible` ~1.27 M, `@upstash/ratelimit` ~705 k.)

The TL;DR: `@devkit/ratelimit` is the only library in the table that runs on every modern runtime, supports every common algorithm, ships every common store adapter, and locks you into nothing.

## Contributing

Contributions are welcome — this is a portfolio project and feedback / PRs help it grow.

```sh
npm install
npm run build
npm test
npm run lint
```

The test suite covers all five algorithms, all six stores, all six framework adapters, and the four composition primitives. Bundle size is enforced via `size-limit` (`npm run size`); types are validated via `attw` and `publint`.

Please open an issue before starting non-trivial work so we can align on direction.

## License

[MIT](./LICENSE) © Mykhailo Kryvytskyi
