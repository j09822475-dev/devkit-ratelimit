/**
 * Public type-only surface. Importing this file pulls in zero runtime code.
 */

export type {
  AlgorithmSpec,
  AlgorithmKind,
  SlidingWindowCounterSpec,
  SlidingWindowLogSpec,
  TokenBucketSpec,
  FixedWindowSpec,
  LeakyBucketSpec,
} from './algorithm.js';
export type {
  HookMode,
  NormalisedRateLimitConfig,
  RateLimitConfig,
  RateLimitFlatConfig,
} from './config.js';
export type { HeaderBuilder, HeaderStyle } from './headers.js';
export type { KeyGenerator, KeyGeneratorContext, StructuredKey } from './key.js';
export type { RateLimiter, RateLimiterMiddleware } from './limiter.js';
export type { RateLimitHook, RateLimitObservation } from './observability.js';
export type { RateLimitResult, RateLimitState } from './result.js';
export type { ConsumeResult, RateLimitStore } from './store.js';
export type { Duration, MinimalRequest } from './runtime.js';
