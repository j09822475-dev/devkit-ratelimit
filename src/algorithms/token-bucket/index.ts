/**
 * Token bucket — `capacity` tokens, refilled at `refill` per `interval`.
 * The canonical "burst-friendly" algorithm: a client can spend `capacity`
 * tokens immediately, then is throttled to the steady refill rate.
 */

import { parseDuration } from '../../core/duration.js';
import { RateLimitError } from '../../errors/base.js';
import type { TokenBucketSpec } from '../../types/algorithm.js';
import { brand } from '../../types/algorithm.js';
import type { Duration } from '../../types/runtime.js';

/**
 * Build a token-bucket spec.
 *
 * @param opts.capacity Bucket size — the maximum burst. Positive integer.
 * @param opts.refill   Tokens added per `interval`. Positive number.
 * @param opts.interval Refill cadence; resolves to ms. Refill is computed
 *                      continuously so the choice is presentational.
 * @returns             A branded {@link TokenBucketSpec}.
 * @throws              `RateLimitError('INVALID_CONFIG')` on bad input.
 * @example
 *   const spec = tokenBucket({ capacity: 50, refill: 5, interval: '1s' });
 */
export function tokenBucket(opts: {
  readonly capacity: number;
  readonly refill: number;
  readonly interval: Duration;
}): TokenBucketSpec {
  if (
    typeof opts.capacity !== 'number' ||
    !Number.isFinite(opts.capacity) ||
    !Number.isInteger(opts.capacity) ||
    opts.capacity <= 0
  ) {
    throw new RateLimitError(
      'INVALID_CONFIG',
      `tokenBucket.capacity must be a positive integer, got ${String(opts.capacity)}`,
    );
  }
  if (
    typeof opts.refill !== 'number' ||
    !Number.isFinite(opts.refill) ||
    opts.refill <= 0
  ) {
    throw new RateLimitError(
      'INVALID_CONFIG',
      `tokenBucket.refill must be a positive finite number, got ${String(opts.refill)}`,
    );
  }
  const intervalMs = parseDuration(opts.interval);
  return brand({
    kind: 'token-bucket' as const,
    capacity: opts.capacity,
    refill: opts.refill,
    intervalMs,
  });
}
