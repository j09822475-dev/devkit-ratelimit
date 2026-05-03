/**
 * Leaky bucket — `capacity` slots, drained at `leak` per `interval`.
 * Smooths outbound traffic to a constant rate; bursts are conceptually
 * queued rather than admitted at full speed.
 */

import { parseDuration } from '../../core/duration.js';
import { RateLimitError } from '../../errors/base.js';
import type { LeakyBucketSpec } from '../../types/algorithm.js';
import { brand } from '../../types/algorithm.js';
import type { Duration } from '../../types/runtime.js';

/**
 * Build a leaky-bucket spec.
 *
 * @param opts.capacity Bucket size. Positive integer.
 * @param opts.leak     Drain rate per `interval`. Positive number.
 * @param opts.interval Leak cadence; resolves to ms.
 * @returns             A branded {@link LeakyBucketSpec}.
 * @throws              `RateLimitError('INVALID_CONFIG')` on bad input
 *                      (including `leak === 0` — a non-leaking bucket
 *                      fills permanently).
 * @example
 *   const spec = leakyBucket({ capacity: 100, leak: 10, interval: '1s' });
 */
export function leakyBucket(opts: {
  readonly capacity: number;
  readonly leak: number;
  readonly interval: Duration;
}): LeakyBucketSpec {
  if (
    typeof opts.capacity !== 'number' ||
    !Number.isFinite(opts.capacity) ||
    !Number.isInteger(opts.capacity) ||
    opts.capacity <= 0
  ) {
    throw new RateLimitError(
      'INVALID_CONFIG',
      `leakyBucket.capacity must be a positive integer, got ${String(opts.capacity)}`,
    );
  }
  if (typeof opts.leak !== 'number' || !Number.isFinite(opts.leak) || opts.leak <= 0) {
    throw new RateLimitError(
      'INVALID_CONFIG',
      `leakyBucket.leak must be > 0 (a non-leaking bucket fills permanently — did you mean tokenBucket?)`,
    );
  }
  const intervalMs = parseDuration(opts.interval);
  return brand({
    kind: 'leaky-bucket' as const,
    capacity: opts.capacity,
    leak: opts.leak,
    intervalMs,
  });
}
