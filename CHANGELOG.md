# Changelog

All notable changes to `@devkit/ratelimit` are documented here. The project follows [Semantic Versioning](https://semver.org/) and the [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format.

## 0.1.0 — 2026-05-03

Initial public release.

### Added

- **Core factory** `createRateLimiter(config)` accepting both sugar (`algorithm: 'sliding-window'`, fields inline) and spec (`algorithm: slidingWindow({ ... })`) construction forms, returning a frozen `RateLimiter<K>` handle with `check`, `peek`, `reset`, `resetKey`, `middleware`, `withExecutionCtx`, and a `config` snapshot.
- **Five algorithms**, each as an independently tree-shakable subpath:
  - `slidingWindow` — sliding-window counter (~1% overshoot, two integer counters per key).
  - `slidingWindowLog` — exact sliding window via per-key timestamp set.
  - `tokenBucket` — burst-friendly capacity with a continuous refill rate.
  - `fixedWindow` — cheapest, single atomic increment per aligned window.
  - `leakyBucket` — constant-rate drain for outbound smoothing.
- **Six storage adapters**:
  - `createMemoryStore` — in-process LRU with periodic sweep.
  - `createRedisStore` — Lua `EVAL`/`EVALSHA` for single-RTT atomicity (works with `ioredis`, `redis@^4`, custom `RedisLike`).
  - `createUpstashStore` — same scripts over the Upstash REST primitive.
  - `createKVStore` — Cloudflare KV with bounded retry on transport errors (best-effort consistency).
  - `createD1Store` — Cloudflare D1 with optimistic-concurrency `WHERE`-guarded UPSERT and bounded retry.
  - `createDurableObjectStore` + `RateLimitDurableObject` — strong per-key consistency via the actor model.
- **Six framework adapters**, each behind its own subpath:
  - `honoRateLimit` (Hono v4) — auto-rebinds via `withExecutionCtx` when `c.executionCtx` is present.
  - `elysiaRateLimit` (Elysia v1).
  - `expressRateLimit` (Express v4 / v5) — translates `(req, res, next)` to a Web-Standard `Request`.
  - `fastifyRateLimit` (Fastify v4 / v5).
  - `withRateLimit` + `rateLimitMiddleware` for Next.js v13.4+ App Router.
  - `rateLimitHandle` for SvelteKit v2.
- **Four composition primitives** (`@devkit/ratelimit/compose`): `composeAll` (logical AND), `composeFirstAllowed` (logical OR with short-circuit), `tieredRateLimiter` (per-plan resolver), `ruledRateLimiter` (first-matching-rule wins).
- **RFC-compliant response headers** — `RateLimit` and `RateLimit-Policy` per `draft-ietf-httpapi-ratelimit-headers-10` (RFC 8941 structured headers), plus legacy `X-RateLimit-*` for older clients. `Retry-After` added per RFC 9110 when blocking. Header style configurable as `'rfc' | 'legacy' | 'both' | 'none'`.
- **Default key generator** — inspects `cf-connecting-ip`, `x-real-ip`, then the first hop of `x-forwarded-for`. Returns `null` when none are present (no silent funnelling into a single bucket). Optional IPv6 prefix collapse via `defaultKeyGeneratorWith({ ipv6Prefix })`. Custom generators may return a structured `{ key, context: K }` so the typed payload threads through `RateLimitResult<K>` and observability events.
- **Observability hooks** — single discriminated event (`'rate-limit.allowed' | 'rate-limit.blocked' | 'rate-limit.skipped' | 'rate-limit.error'`) with three execution modes: `'fire-and-forget'` (default, `queueMicrotask`), `'sync'` (awaited inline, bounded by `hookTimeoutMs`), `'wait-until'` (runs through `executionCtx.waitUntil` on Workers / Vercel Edge).
- **Fail-open / fail-closed** toggle — `failOpen: true` swallows infrastructure errors and returns `{ allowed: true, degraded: true }`; default propagates `STORE_UNAVAILABLE`.
- **Per-call cost override** — `limiter.check(req, { cost: 5 })` for variable-weight requests (e.g. expensive AI endpoints). Default cost validated `> 0` at construction time.
- **`Duration` parser** — accepts `number` ms, template-literal strings (`'1m'`, `'500 ms'`), or object form (`{ minutes: 1.5 }`). Template-literal type rejects decimals at the call site; runtime regex re-validates as defence-in-depth.
- **Stable error catalogue** — `RateLimitError` carries one of `INVALID_CONFIG | INVALID_COST | INVALID_KEY | INVALID_TIER | STORE_UNAVAILABLE | WINDOW_TOO_LARGE | PAYLOAD_TOO_LARGE | KEY_TOO_LONG`. `RateLimitError.is(value)` is a cross-realm-safe type guard.
- **Strict TypeScript surface** — branded algorithm specs (cannot be forged via `as`), inferred structured-key context, exhaustive `switch` on error codes and algorithm kinds, full type-only entrypoint via `@devkit/ratelimit` types re-export.
- **Zero runtime dependencies** in core. Each adapter declares its peer (Redis client / Upstash / framework) as optional.
- Bundle budgets enforced via `size-limit`: core ≤ 3.2 KB gz, every adapter ≤ 2 KB gz.
- Multi-runtime support: Node ≥ 20, Bun, Deno, Cloudflare Workers, Vercel Edge, Netlify Edge, browsers.
- Comprehensive unit, integration and type tests under `src/__tests__`; coverage configured via `@vitest/coverage-v8`. Type packaging validated with `@arethetypeswrong/cli` and `publint`.
