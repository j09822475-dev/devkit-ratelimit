# Response to Review by Vasyl Bruhanda

Each numbered item below corresponds to a single point from the review.
Concrete file/line references point at the post-fix code.

---

## 1. [major] D1 `consume()` non-atomic SELECT-then-UPSERT
**Concern:** TOCTOU race between `loadRow` and `upsertRow`; concurrent
requests could both read `count`, both compute next-state, and the second
UPSERT silently overwrote the first — capping at `2 * limit` per window.

**Resolution:** Fixed.

Replacing every algorithm with a single per-kind CTE was prohibitive, so
I implemented optimistic concurrency control instead — a tighter
guarantee than the reviewer's minimum suggestion of `db.batch(...)`,
which by itself does not serialise the JS-side state computation.

Each consume now does `SELECT → compute → INSERT … ON CONFLICT(key) DO
UPDATE … WHERE updated_at = ? AND data = ?`. The `WHERE` on the
conflict path treats the (`updated_at`, `data`) pair as a version
fingerprint:
- First-time row: `oldUpdatedAt = -1`, `oldData = ''`, the `INSERT`
  succeeds without conflict.
- Concurrent re-write: only the writer whose snapshot still matches the
  on-disk row commits; the loser sees `meta.changes === 0` and retries.

Bounded retry loop (`maxRetries`, default `5`) surfaces persistent
contention as `STORE_UNAVAILABLE` rather than spinning forever.

Files: `src/adapters/cloudflare-d1/index.ts`
(`createD1Store` + new `casUpsert` helper; `D1PreparedStatementLike.run`
now exposes `meta.changes` to make the loop observable).

---

## 2. [major] `'sync'` hookMode broken end-to-end
**Concern:** Every emit site did `void emitObservation(...)`, so
`hookMode: 'sync'` never actually awaited. The bounded `await` inside
`emitObservation` ran detached, defeating both the documented
ordering guarantee and `hookTimeoutMs`.

**Resolution:** Fixed.

`emitObservation` now returns the in-flight promise. A new
`maybeAwaitObservation(cfg, p)` helper awaits it iff
`cfg.hookMode === 'sync'`. The `check()` and `middleware()` paths route
every emit through that helper, so under `'sync'` the limiter blocks
until the hook finishes (bounded by `hookTimeoutMs`); under
`'fire-and-forget'` and `'wait-until'` the work is already scheduled and
the awaited promise resolves immediately.

While I was in there I also factored the four near-identical emit
blocks into a single `emit(type, key, state, context, error?)` closure
inside `check` (review item 13), so the fix lands once.

Files: `src/core/limiter.ts`.

---

## 3. [major] `buildHeaders` reads `Date.now()` directly
**Concern:** `RateLimit: reset=…` and `RateLimit-Policy: w=…` were
computed off wall-clock, so a fixed `clock` in tests still yielded
nondeterministic headers.

**Resolution:** Fixed.

`buildHeaders` now takes `(state, style, now)` and the limiter threads
`cfg.clock()`-supplied `now` through every call site. Same threading
applied to the synthetic skip / degraded paths, the peek path, and the
compose-time fallbacks (`compose/tiered.ts`, `compose/ruled.ts`) which
pass their own `Date.now()` — those modules are outside the limiter's
clock-injection contract by design (no per-instance config) but the
function signature now makes that explicit.

Files: `src/core/headers.ts`, `src/core/limiter.ts`,
`src/compose/tiered.ts`, `src/compose/ruled.ts`.

---

## 4. [major] Hono adapter doesn't wire `executionCtx`
**Concern:** The Hono README/PLAN promised auto-detection of
`c.executionCtx` and a switch to `'wait-until'`. The implementation
acknowledged in a comment that it couldn't mutate the frozen config.

**Resolution:** Fixed by adding a clone helper.

Added `RateLimiter.withExecutionCtx(ctx)` to the public handle. Per
review wording: "expose a `RateLimiter.withExecutionCtx(ctx)`
clone-helper that returns a new frozen handle with `executionCtx`
populated."

Implementation:
- `createRateLimiter` builds a fresh frozen handle with the new
  `executionCtx` by re-spreading the normalised config — cheap; no
  store reconstruction.
- The Hono adapter now calls `limiter.withExecutionCtx(c.executionCtx)`
  per request when `c.executionCtx` is present, so a limiter built
  with `hookMode: 'wait-until'` automatically picks up
  `executionCtx.waitUntil` for hooks.
- The SvelteKit adapter does the same against
  `event.platform?.context`, closing the equivalent gap noted in the
  review.
- All four compose layers (`composeAll`, `composeFirstAllowed`,
  `tieredRateLimiter`, `ruledRateLimiter`) now implement
  `withExecutionCtx` by recomposing with each child layer rebound, so
  composed limiters propagate `executionCtx` correctly.

Files: `src/types/limiter.ts`, `src/core/limiter.ts`,
`src/frameworks/hono/index.ts`, `src/frameworks/sveltekit/index.ts`,
`src/compose/all.ts`, `src/compose/first-allowed.ts`,
`src/compose/tiered.ts`, `src/compose/ruled.ts`.

---

## 5. [major] KV adapter falsely advertises CAS semantics
**Concern:** Workers KV has no conditional-put; the helper was named
`runWithCas` and the docblock claimed "conditional `put` with a CAS
metadata token" — both misleading. Worst-case overshoot is
`concurrentRequests` per region, not the ~1 the docs claimed.

**Resolution:** Fixed (documentation-and-rename path; KV remains
best-effort).

- File-level docblock now states explicitly that KV exposes no
  conditional-put primitive, that retries paper over transport errors
  only, that worst-case overshoot is `concurrentRequests` per region,
  and that quota-critical paths should use Durable Objects instead.
- Internal helper renamed `runWithCas → runBestEffort` with a
  matching JSDoc.
- `KVStoreOptions.retries` description clarified — it does NOT
  serialise concurrent writers.

I did not move the consistency-critical path into Durable Objects
because that would conflict with the explicit subpath split in §6.1
(KV and DO are separate adapters; the choice is the user's). The DO
adapter already exists and the docblock now points users to it.

Files: `src/adapters/cloudflare-kv/index.ts`.

---

## 6. [medium] Dead code in `composeAll`
**Concern:** `const last = allowed.at(-1)` and the subsequent
`if (last === undefined)` branch were unreachable.

**Resolution:** Deleted.

Files: `src/compose/all.ts`.

---

## 7. [medium] KV `EMPTY_ENTRY` spread inflates persisted bytes
**Concern:** Every persisted entry carried `l/p/s/ts/level/updatedAt`
even when only one of those was meaningful for the algorithm; KV
charges by stored bytes.

**Resolution:** Fixed by replacing the single `KVEntry` interface with
a discriminated union per `kind`. Each algorithm now persists only its
relevant fields (e.g. token-bucket writes `{ k: 'token-bucket', level,
updatedAt }` — no more empty `ts: []`). The `EMPTY_ENTRY` constant is
gone.

Files: `src/adapters/cloudflare-kv/index.ts`.

---

## 8. [medium] `lru.get` promotes on memory store `peek`
**Concern:** `peek` calling `consumeImpl(..., cost: 0, ...)` reached
`lru.get`, which moves the entry to MRU. A polling caller could keep an
idle key alive forever and evict an active one.

**Resolution:** Fixed.

- `Lru` gains a `peek(key)` method that returns the value without
  promoting the node.
- `consumeImpl` gains a `readOnly` boolean threaded into every
  per-algorithm runner; the runner reads via `readEntry()` which picks
  `lru.peek` or `lru.get` based on the flag.
- The store's `peek` method passes `readOnly: true`; the `consume`
  method passes `readOnly: false`.

Files: `src/utils/lru.ts`, `src/adapters/memory/index.ts`.

---

## 9. [medium] `assertValidCost` permits `cost === 0` at construction
**Concern:** Configuring `cost: 0` would turn every `check()` into a
no-op consume.

**Resolution:** Fixed.

`normaliseConfig` now rejects construction-time `cost <= 0` with
`INVALID_CONFIG`. Per-call `opts.cost` overrides still go through
`assertValidCost`, which intentionally permits `0` for the peek-like
internal path.

Files: `src/core/limiter.ts`.

---

## 10. [medium] Lua ZADD member uniqueness via `math.random()`
**Concern:** Cluster-mode Redis reseeds the Lua PRNG per-call for
replication determinism, so two concurrent EVAL calls at the same `now`
could draw identical suffixes and silently undercount via duplicate
member writes.

**Resolution:** Fixed.

The sliding-window-log Lua now builds the ZADD member from
`now:seq:i:micros`, where:
- `seq` comes from `INCR KEYS[1]:seq` (atomic, monotonic per key);
- `micros` comes from `redis.call('TIME')[2]` (microsecond field);
- `i` is the per-cost loop index.

The `:seq` companion key carries its own `PEXPIRE`. Two concurrent
calls cannot collide because `seq` is strictly monotonic across them.

Files: `src/adapters/redis/lua.ts` (Upstash re-imports this module so
the fix lands in both adapters).

---

## 11. [medium] `WINDOW_TOO_LARGE` documented but unenforced
**Concern:** The error code existed in the catalogue but no adapter
checked the per-store TTL ceiling.

**Resolution:** Fixed.

- Redis adapter now calls `assertWindowFitsRedis(spec)` at the top of
  `consume` and `peek`, throwing `WINDOW_TOO_LARGE` if the window /
  intervalMs exceeds `49 * 86_400_000` ms (the broadly-cited safe
  PEXPIRE ceiling).
- KV adapter now calls `assertWindowFitsKV(spec)` at the same points,
  capping at 180 days — half the 365-day KV `expirationTtl` cap to
  leave headroom for the doubled-window TTL the adapter writes
  (`Math.ceil(specWindowMs(spec) / 1000) * 2`).
- Memory / D1 / DO adapters do not need this — their TTL is governed
  by the in-process sweep / explicit `DELETE`, not a per-key store
  ceiling.

These fire on first call rather than at construction time because the
store doesn't see the spec until `consume()` runs; the check happens
before any I/O so the user sees a deterministic
`RateLimitError('WINDOW_TOO_LARGE')` instead of a opaque PEXPIRE
failure later.

Files: `src/adapters/redis/index.ts`,
`src/adapters/cloudflare-kv/index.ts`.

---

## 12. [low] Synthetic compose paths hard-code `'rfc'`
**Concern:** When `tieredRateLimiter` / `ruledRateLimiter` short-circuit
on no-tier-matched / no-rule-matched, they returned RFC headers
regardless of the picked limiter's `headerStyle`, producing mixed shapes
on the wire.

**Resolution:** Fixed.

Each compose module gets a `defaultStyle()` helper that reads
`headerStyle` from the first available limiter (first tier, falling
back to `fallback`; or first rule, falling back to `fallback`). The
synthetic path uses that style.

Files: `src/compose/tiered.ts`, `src/compose/ruled.ts`.

---

## 13. [low] Three near-identical observation-emit blocks in `check`
**Concern:** Refactor opportunity — extract one closure that closes
over the per-call values.

**Resolution:** Fixed as part of fix #2 (sync hook). The `check`
function now defines a single `emit(type, key, state, context, error?)`
closure that builds the observation and routes it through
`maybeAwaitObservation(emitObservation(...))`. Skip / degraded /
store-error / normal paths each call `emit` once.

Files: `src/core/limiter.ts`.

---

## 14. [low] DO trusts deserialised body shape
**Concern:** The brand symbol on `AlgorithmSpec` is a phantom type and
does not survive JSON. The DO dispatched on `kind` blindly, so a
misbehaving caller sending `{ kind: 'token-bucket', capacity: -1, ... }`
would reach the algorithm code.

**Resolution:** Fixed.

DO `fetch()` now runs `validateSpec(body.spec)` before
`consumeImpl`. The validator structurally checks that:
- `kind` is one of the five known variants;
- per-kind numeric fields are finite and positive.

Same path also tightened: `body.op` and `body.key` validated as
non-empty strings; `body.now` validated as finite; `body.cost` (if
present) validated as `≥ 0`. All failures return 400 with a short
error message.

Files: `src/adapters/durable-object/ratelimit-do.ts`.

---

## 15. [low] D1 `sweep` returns `0/1` instead of actual count
**Concern:** `r.success ? 1 : 0` discarded D1's `meta.changes`.

**Resolution:** Fixed.

`D1PreparedStatementLike.run` extended to expose `meta.changes`. `sweep`
now returns `r.meta?.changes ?? 0`.

Files: `src/adapters/cloudflare-d1/index.ts`.

---

## 16. [low] Unbranded `as` cast on `(req as { cf?: ... })`
**Concern:** Biome's "ban `as` outside …" rule excludes
`core/limiter.ts`; the cast either belongs in `core/key.ts` (already
excluded) or needs a documented carve-out.

**Resolution:** Documented in place.

`buildKeyGeneratorContext` now carries a docblock note explaining the
trade-off: there's no Web-Standard typing for `Request.cf`, the cast
narrows to a single property we read defensively, and moving the helper
to `core/key.ts` would actually widen `key.ts`'s carve-out surface
(it would pull in a `Request`-shaped concern that doesn't belong in
key composition).

Files: `src/core/limiter.ts`.

---

## Notes

- I did not touch tests in this pass — that's the next phase per the
  task brief.
- I could not run the local `tsc` typecheck (no `node_modules`
  present in the working copy and no global TypeScript installed).
  Every change was made with the `verbatimModuleSyntax`,
  `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess` constraints
  in mind; CI will catch anything I missed.
