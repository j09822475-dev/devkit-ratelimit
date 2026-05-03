/**
 * `createRateLimiter` — the central factory. Composes a store + algorithm
 * + key generator + headers builder into a frozen handle. Two construction
 * forms (spec / sugar) share one implementation.
 */

import { RateLimitError } from '../errors/base.js';
import type { AlgorithmSpec } from '../types/algorithm.js';
import type {
  HookMode,
  NormalisedRateLimitConfig,
  RateLimitConfig,
  RateLimitFlatConfig,
} from '../types/config.js';
import type { HeaderStyle } from '../types/headers.js';
import type { KeyGenerator, KeyGeneratorContext, StructuredKey } from '../types/key.js';
import type { RateLimiter, RateLimiterMiddleware } from '../types/limiter.js';
import type { RateLimitHook, RateLimitObservation } from '../types/observability.js';
import type { RateLimitResult, RateLimitState } from '../types/result.js';
import type { ConsumeResult } from '../types/store.js';
import { normaliseFlatAlgorithm } from './algorithm-spec.js';
import { asState, assertValidCost, runConsume, runPeek, wrapStoreError } from './consume.js';
import { buildHeaders } from './headers.js';
import { invariant } from './invariant.js';
import { composeKey, defaultKeyGenerator } from './key.js';
import { build429Response } from './response.js';
import { nowMs } from './time.js';
import { djb2 } from '../utils/hash.js';

const DEFAULT_PREFIX = 'rl';
const DEFAULT_HEADER_STYLE: HeaderStyle = 'rfc';
const DEFAULT_HOOK_MODE: HookMode = 'fire-and-forget';
const DEFAULT_HOOK_TIMEOUT_MS = 50;
const DEFAULT_MAX_KEY_LENGTH = 1024;

/**
 * Type guard — `true` when `config` is a flat-form (sugar) config.
 *
 * @param config Either form of the config.
 * @returns      `true` when sugar form.
 */
function isFlatConfig<K>(
  config: RateLimitConfig<K> | RateLimitFlatConfig<K>,
): config is RateLimitFlatConfig<K> {
  return typeof (config as { algorithm: unknown }).algorithm === 'string';
}

/**
 * Default scope — a stable hash of the algorithm spec so two limiters
 * with the same prefix but different policies cannot collide.
 *
 * @param spec Algorithm spec.
 * @returns    Short, URL-safe scope string.
 */
function defaultScope(spec: AlgorithmSpec): string {
  // We hash the JSON representation; the brand symbol is not enumerable
  // so it does not contribute, which keeps the scope stable across runs.
  const fingerprint = JSON.stringify({
    k: spec.kind,
    ...specFingerprintFields(spec),
  });
  return `${spec.kind}:${djb2(fingerprint)}`;
}

function specFingerprintFields(spec: AlgorithmSpec): Record<string, number> {
  switch (spec.kind) {
    case 'sliding-window-counter':
    case 'sliding-window-log':
    case 'fixed-window':
      return { l: spec.limit, w: spec.windowMs };
    case 'token-bucket':
      return { c: spec.capacity, r: spec.refill, i: spec.intervalMs };
    case 'leaky-bucket':
      return { c: spec.capacity, l: spec.leak, i: spec.intervalMs };
    default: {
      const exhaustive: never = spec;
      void exhaustive;
      return {};
    }
  }
}

/**
 * Normalise a public config into the frozen, fully-defaulted shape the
 * limiter's hot path uses internally.
 */
function normaliseConfig<K>(
  config: RateLimitConfig<K> | RateLimitFlatConfig<K>,
): NormalisedRateLimitConfig<K> {
  let algorithm: AlgorithmSpec;
  if (isFlatConfig<K>(config)) {
    algorithm = normaliseFlatAlgorithm(config);
  } else {
    algorithm = config.algorithm;
    invariant(
      algorithm !== null && typeof algorithm === 'object' && typeof algorithm.kind === 'string',
      'INVALID_CONFIG',
      'algorithm must be produced by an algorithm factory or sugar overload',
    );
  }

  invariant(
    config.store !== null && typeof config.store === 'object',
    'INVALID_CONFIG',
    'store is required — import an adapter from @devkit/ratelimit/adapters/*',
  );

  // We default `keyGenerator` to one that returns `string | null`. When
  // the consumer supplies their own structured generator the `K`
  // parameter narrows naturally; we widen the default by casting the
  // type rather than the value (no runtime cost).
  const keyGenerator: KeyGenerator<K> =
    config.keyGenerator ?? (defaultKeyGenerator as KeyGenerator<K>);

  const prefix = config.prefix ?? DEFAULT_PREFIX;
  const scope = config.scope ?? defaultScope(algorithm);
  const headerStyle = config.headerStyle ?? DEFAULT_HEADER_STYLE;
  const message = config.message ?? 'Too Many Requests';
  const failOpen = config.failOpen ?? false;
  const cost = config.cost ?? 1;
  // The construction-time default cost MUST be > 0 — a default of 0 would
  // turn every `check()` into a no-op consume. Per-call overrides MAY be
  // 0 (peek-like), validated separately at the call site.
  if (!Number.isFinite(cost) || cost <= 0) {
    throw new RateLimitError(
      'INVALID_CONFIG',
      `cost (default per-call) must be > 0, got ${String(cost)}`,
    );
  }
  const hookMode = config.hookMode ?? DEFAULT_HOOK_MODE;
  const hookTimeoutMs = config.hookTimeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS;
  const clock = config.clock ?? nowMs;
  const maxKeyLength = config.maxKeyLength ?? DEFAULT_MAX_KEY_LENGTH;

  const responseBuilder =
    config.responseBuilder ??
    (((info: RateLimitResult<K> & { req: Request }) => build429Response(info, message)) as (
      info: RateLimitResult<K> & { req: Request },
    ) => Response | Promise<Response>);

  return Object.freeze<NormalisedRateLimitConfig<K>>({
    algorithm,
    store: config.store,
    keyGenerator,
    prefix,
    scope,
    headerStyle,
    responseBuilder,
    message,
    failOpen,
    cost,
    on: config.on,
    hookMode,
    hookTimeoutMs,
    clock,
    maxKeyLength,
    executionCtx: config.executionCtx,
  });
}

/**
 * Sentinel returned from {@link extractKey} when the request should be
 * skipped (no IP, key generator returned `null` / `''`).
 */
const SKIP = Symbol('rl.skip');

interface ExtractedKey<K> {
  readonly userKey: string;
  readonly storeKey: string;
  readonly context: K;
}

/**
 * Build the `KeyGeneratorContext` from a `Request`. Cloudflare workers
 * attach `cf` directly to the request (non-standard but ubiquitous on
 * Workers); we read it defensively without typing the shape — adapters
 * always pass the Web-Standard `Request`. The carve-out for the unbranded
 * `as` cast is documented here: there is no Web-Standard typing for
 * `Request.cf` and we already restrict the cast to the single property
 * we read, so the alternative — moving this helper to `core/key.ts` to
 * inherit that file's broader Biome carve-out — would actually widen the
 * surface.
 */
function buildKeyGeneratorContext(req: Request): KeyGeneratorContext {
  const cf = (req as { cf?: { connectingIp?: unknown } }).cf;
  const connectingIp = typeof cf?.connectingIp === 'string' ? cf.connectingIp : undefined;
  return connectingIp !== undefined ? { connectingIp } : {};
}

/**
 * Run the configured key generator and produce a fully-qualified store
 * key. Honours `failOpen` for the throwing path: fail-closed wraps the
 * cause in `INVALID_KEY`; fail-open tells the caller to skip and emit a
 * `'rate-limit.error'` observation.
 */
async function extractKey<K>(
  req: Request,
  cfg: NormalisedRateLimitConfig<K>,
): Promise<ExtractedKey<K> | typeof SKIP | { degraded: true; error: RateLimitError }> {
  const ctx = buildKeyGeneratorContext(req);
  let raw: string | null | undefined | StructuredKey<K>;
  try {
    raw = await cfg.keyGenerator(req, ctx);
  } catch (err) {
    const wrapped = RateLimitError.is(err)
      ? err
      : new RateLimitError('INVALID_KEY', 'keyGenerator threw', err);
    if (cfg.failOpen) return { degraded: true, error: wrapped };
    throw wrapped;
  }
  if (raw === null || raw === undefined || raw === '') return SKIP;

  let userKey: string;
  let context: K;
  if (typeof raw === 'string') {
    userKey = raw;
    context = undefined as K;
  } else {
    userKey = raw.key;
    context = raw.context;
  }
  if (typeof userKey !== 'string' || userKey === '') return SKIP;
  if (userKey.length > cfg.maxKeyLength) {
    throw new RateLimitError(
      'KEY_TOO_LONG',
      `key length ${userKey.length} exceeds maxKeyLength ${cfg.maxKeyLength}`,
    );
  }
  const storeKey = composeKey(cfg.prefix, cfg.scope, userKey);
  return { userKey, storeKey, context };
}

/**
 * Build a successful "skipped" result — used when the key generator
 * declines to produce a key.
 */
function buildSkippedResult<K>(cfg: NormalisedRateLimitConfig<K>, now: number): RateLimitResult<K> {
  const limit = (() => {
    switch (cfg.algorithm.kind) {
      case 'token-bucket':
      case 'leaky-bucket':
        return cfg.algorithm.capacity;
      case 'sliding-window-counter':
      case 'sliding-window-log':
      case 'fixed-window':
        return cfg.algorithm.limit;
      default: {
        const exhaustive: never = cfg.algorithm;
        void exhaustive;
        return 0;
      }
    }
  })();
  const state: RateLimitState = { limit, remaining: limit, reset: now, retryAfter: 0 };
  return {
    allowed: true,
    key: '',
    state,
    headers: buildHeaders(state, cfg.headerStyle, now),
    degraded: false,
    context: undefined as K,
  };
}

/**
 * Build a degraded "fail-open" result — used when the key generator threw
 * under `failOpen: true`.
 */
function buildDegradedResult<K>(
  cfg: NormalisedRateLimitConfig<K>,
  now: number,
): RateLimitResult<K> {
  const r = buildSkippedResult(cfg, now);
  return { ...r, degraded: true };
}

/**
 * Emit an observation event. Honours `hookMode`. Errors thrown by the
 * hook are always swallowed.
 *
 * Returns the in-flight promise only for `'sync'` mode — other modes
 * detach the work and resolve immediately. Callers that need
 * `'sync'` to actually be synchronous MUST await the returned promise
 * (see {@link maybeAwaitObservation}).
 *
 * @internal
 */
function emitObservation<K>(
  cfg: NormalisedRateLimitConfig<K>,
  event: RateLimitObservation<K>,
): Promise<void> {
  const hook = cfg.on;
  if (hook === undefined) return Promise.resolve();
  if (cfg.hookMode === 'fire-and-forget') {
    queueMicrotask(() => {
      // We use a void IIFE so no caller awaits the promise; rejections
      // are caught and silently dropped per the contract.
      void runHookSafely(hook, event);
    });
    return Promise.resolve();
  }
  if (cfg.hookMode === 'wait-until') {
    const ctx = cfg.executionCtx;
    if (ctx !== undefined) {
      ctx.waitUntil(runHookSafely(hook, event));
      return Promise.resolve();
    }
    // Fall back to fire-and-forget when no executionCtx is wired.
    queueMicrotask(() => void runHookSafely(hook, event));
    return Promise.resolve();
  }
  // 'sync' — bounded, awaited inline by the caller.
  return runHookSafelyBounded(hook, event, cfg.hookTimeoutMs);
}

/**
 * Await an emitted observation only when `hookMode === 'sync'`. For
 * `'fire-and-forget'` and `'wait-until'` the work has already been
 * scheduled and the promise resolves immediately — awaiting it is a
 * no-op but harmless.
 *
 * @internal
 */
async function maybeAwaitObservation<K>(
  cfg: NormalisedRateLimitConfig<K>,
  p: Promise<void>,
): Promise<void> {
  if (cfg.hookMode === 'sync') await p;
}

async function runHookSafely<K>(
  hook: RateLimitHook<K>,
  event: RateLimitObservation<K>,
): Promise<void> {
  try {
    await hook(event);
  } catch {
    // Hooks are best-effort by contract; we swallow.
  }
}

async function runHookSafelyBounded<K>(
  hook: RateLimitHook<K>,
  event: RateLimitObservation<K>,
  timeoutMs: number,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });
  try {
    await Promise.race([runHookSafely(hook, event), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Build the structured observation event emitted on every check / peek.
 *
 * @internal
 */
function buildObservation<K>(
  type: RateLimitObservation<K>['type'],
  key: string,
  state: RateLimitState,
  cfg: NormalisedRateLimitConfig<K>,
  cost: number,
  startedAt: number,
  now: number,
  req: Request,
  context: K,
  error?: RateLimitError,
): RateLimitObservation<K> {
  let path = '/';
  try {
    path = new URL(req.url).pathname;
  } catch {
    // Some adapter shims (legacy Express) pass a non-URL `req.url`.
    path = req.url;
  }
  const obs: RateLimitObservation<K> = {
    type,
    key,
    state,
    algorithm: cfg.algorithm,
    cost,
    startedAt,
    elapsedMs: Math.max(0, now - startedAt),
    method: req.method,
    path,
    request: req,
    context,
    ...(error !== undefined ? { error } : {}),
  };
  return obs;
}

/**
 * Public factory — accepts either spec-form or sugar-form config and
 * produces a frozen {@link RateLimiter}.
 *
 * @typeParam K Caller-defined context payload threaded from the structured
 *              key generator.
 * @param config Spec-form or sugar-form configuration.
 * @returns      A frozen {@link RateLimiter}.
 * @throws       `RateLimitError('INVALID_CONFIG')` on bad input.
 * @example  Sugar form
 *   const limiter = createRateLimiter({
 *     algorithm: 'sliding-window',
 *     limit: 100,
 *     window: '1m',
 *     store: createMemoryStore(),
 *   });
 *
 * @example  Spec form
 *   const limiter = createRateLimiter({
 *     algorithm: slidingWindow({ limit: 100, window: '1m' }),
 *     store: createMemoryStore(),
 *   });
 */
export function createRateLimiter<K = undefined>(
  config: RateLimitConfig<K>,
): RateLimiter<K>;
export function createRateLimiter<K = undefined>(
  config: RateLimitFlatConfig<K>,
): RateLimiter<K>;
export function createRateLimiter<K = undefined>(
  config: RateLimitConfig<K> | RateLimitFlatConfig<K>,
): RateLimiter<K> {
  const cfg = normaliseConfig(config);

  /**
   * Run the consume pipeline and produce a public {@link RateLimitResult}.
   */
  async function check(
    req: Request,
    opts?: { cost?: number },
  ): Promise<RateLimitResult<K>> {
    const cost = opts?.cost ?? cfg.cost;
    assertValidCost(cost);
    const startedAt = cfg.clock();
    const extracted = await extractKey(req, cfg);
    const now = cfg.clock();

    // Single emit closure — closes over the values shared by every code
    // path below. Returns the promise so callers can `await` under
    // `hookMode === 'sync'` (the wrapper handles the dispatch).
    const emit = (
      type: RateLimitObservation<K>['type'],
      key: string,
      state: RateLimitState,
      context: K,
      error?: RateLimitError,
    ): Promise<void> =>
      maybeAwaitObservation(
        cfg,
        emitObservation(
          cfg,
          buildObservation(type, key, state, cfg, cost, startedAt, now, req, context, error),
        ),
      );

    if (extracted === SKIP) {
      const result = buildSkippedResult(cfg, now);
      await emit('rate-limit.skipped', '', result.state, undefined as K);
      return result;
    }
    if ('degraded' in extracted) {
      const result = buildDegradedResult(cfg, now);
      await emit('rate-limit.error', '', result.state, undefined as K, extracted.error);
      return result;
    }

    let consumeResult: ConsumeResult & { degraded: boolean };
    try {
      consumeResult = await runConsume(
        cfg.store,
        extracted.storeKey,
        cfg.algorithm,
        cost,
        now,
        cfg.failOpen,
      );
    } catch (err) {
      const wrapped = RateLimitError.is(err) ? err : wrapStoreError(err, cfg.store);
      await emit(
        'rate-limit.error',
        extracted.storeKey,
        { limit: 0, remaining: 0, reset: now, retryAfter: 0 },
        extracted.context,
        wrapped,
      );
      throw wrapped;
    }

    const state = asState(consumeResult);
    const headers = buildHeaders(state, cfg.headerStyle, now);
    const result: RateLimitResult<K> = {
      allowed: consumeResult.allowed,
      key: extracted.storeKey,
      state,
      headers,
      degraded: consumeResult.degraded,
      context: extracted.context,
    };
    const type: RateLimitObservation<K>['type'] = consumeResult.degraded
      ? 'rate-limit.error'
      : consumeResult.allowed
        ? 'rate-limit.allowed'
        : 'rate-limit.blocked';
    await emit(type, extracted.storeKey, state, extracted.context);
    return result;
  }

  /**
   * Inspect current state for a request without consuming.
   */
  async function peek(req: Request): Promise<RateLimitResult<K>> {
    const extracted = await extractKey(req, cfg);
    const now = cfg.clock();
    if (extracted === SKIP) return buildSkippedResult(cfg, now);
    if ('degraded' in extracted) return buildDegradedResult(cfg, now);
    const peekResult = await runPeek(
      cfg.store,
      extracted.storeKey,
      cfg.algorithm,
      now,
      cfg.failOpen,
    );
    const state = asState(peekResult);
    const headers = buildHeaders(state, cfg.headerStyle, now);
    return {
      allowed: true,
      key: extracted.storeKey,
      state,
      headers,
      degraded: peekResult.degraded,
      context: extracted.context,
    };
  }

  /**
   * Reset the counter for a request's key.
   */
  async function reset(req: Request): Promise<boolean> {
    const extracted = await extractKey(req, cfg);
    if (extracted === SKIP || 'degraded' in extracted) return false;
    return cfg.store.reset(extracted.storeKey);
  }

  /**
   * Reset by an explicit user key.
   */
  async function resetKey(userKey: string): Promise<boolean> {
    if (typeof userKey !== 'string' || userKey === '') return false;
    return cfg.store.reset(composeKey(cfg.prefix, cfg.scope, userKey));
  }

  /**
   * Build a Web-Standard middleware over `check` + the configured
   * `responseBuilder`.
   */
  function middleware(): RateLimiterMiddleware {
    return async (req: Request): Promise<Response | undefined> => {
      const result = await check(req);
      if (result.allowed) return undefined;
      try {
        const response = await cfg.responseBuilder({ ...result, req });
        if (response instanceof Response) return response;
        if (typeof response === 'string') {
          return new Response(response, {
            status: 429,
            headers: result.headers,
          });
        }
        // Non-Response, non-string returns are a programmer error.
        throw new RateLimitError(
          'INVALID_CONFIG',
          'responseBuilder must return Response or string',
        );
      } catch (err) {
        if (RateLimitError.is(err)) throw err;
        // Builder threw — fall back to the default plain-text 429 and
        // emit an error observation so ops can alert on the bug.
        const now = cfg.clock();
        await maybeAwaitObservation(
          cfg,
          emitObservation(
            cfg,
            buildObservation(
              'rate-limit.error',
              result.key,
              result.state,
              cfg,
              cfg.cost,
              now,
              now,
              req,
              result.context,
              new RateLimitError('INVALID_CONFIG', 'responseBuilder threw', err),
            ),
          ),
        );
        return build429Response(result, cfg.message);
      }
    };
  }

  function withExecutionCtx(
    executionCtx: { waitUntil(p: Promise<unknown>): void },
  ): RateLimiter<K> {
    // Re-frame the existing config rather than re-running normaliseConfig.
    // We rebuild the limiter with the same store and algorithm so the
    // returned handle's hot path is identical — the only difference is
    // the executionCtx baked into the frozen config.
    return createRateLimiter<K>({
      ...cfg,
      executionCtx,
    } as RateLimitConfig<K>);
  }

  const handle: RateLimiter<K> = Object.freeze<RateLimiter<K>>({
    check,
    peek,
    reset,
    resetKey,
    middleware,
    withExecutionCtx,
    config: cfg,
  });
  return handle;
}
