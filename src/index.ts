/**
 * `@devkit/ratelimit` — public root entrypoint. Re-exports the central
 * factory, default helpers, and the type-only public surface. Adapters
 * and algorithm subpaths live behind their own subpath exports so the
 * core stays ≤3.2 KB gzipped.
 */

export { createRateLimiter } from './core/limiter.js';
export { defaultKeyGenerator, defaultKeyGeneratorWith, composeKey } from './core/key.js';
export { parseDuration } from './core/duration.js';
export { RateLimitError } from './errors/base.js';
export type { RateLimitErrorCode } from './errors/codes.js';

export type {
  AlgorithmKind,
  AlgorithmSpec,
  Duration,
  FixedWindowSpec,
  HeaderBuilder,
  HeaderStyle,
  HookMode,
  KeyGenerator,
  KeyGeneratorContext,
  LeakyBucketSpec,
  MinimalRequest,
  NormalisedRateLimitConfig,
  RateLimitConfig,
  RateLimitFlatConfig,
  RateLimitHook,
  RateLimitObservation,
  RateLimitResult,
  RateLimitState,
  RateLimitStore,
  RateLimiter,
  RateLimiterMiddleware,
  SlidingWindowCounterSpec,
  SlidingWindowLogSpec,
  StructuredKey,
  TokenBucketSpec,
} from './types/index.js';
