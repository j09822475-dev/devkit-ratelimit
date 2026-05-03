/**
 * Sliding-window log — exact bound, no approximation. Stores per-key
 * timestamps and counts those within the window on each check. Memory
 * cost is O(limit) per key vs the counter's O(1); pick this when accuracy
 * matters more than memory cost (billing-critical, compliance-driven).
 */

import { parseDuration } from '../../core/duration.js';
import { RateLimitError } from '../../errors/base.js';
import type { SlidingWindowLogSpec } from '../../types/algorithm.js';
import { brand } from '../../types/algorithm.js';
import type { Duration } from '../../types/runtime.js';

/**
 * Build a sliding-window log spec.
 *
 * @param opts.limit  Maximum number of permits per `window`. MUST be a
 *                    positive finite integer.
 * @param opts.window Window length.
 * @returns           A branded {@link SlidingWindowLogSpec}.
 * @throws            `RateLimitError('INVALID_CONFIG')` on bad input.
 * @example
 *   const spec = slidingWindowLog({ limit: 1000, window: '1h' });
 */
export function slidingWindowLog(opts: {
  readonly limit: number;
  readonly window: Duration;
}): SlidingWindowLogSpec {
  if (
    typeof opts.limit !== 'number' ||
    !Number.isFinite(opts.limit) ||
    !Number.isInteger(opts.limit) ||
    opts.limit <= 0
  ) {
    throw new RateLimitError(
      'INVALID_CONFIG',
      `slidingWindowLog.limit must be a positive integer, got ${String(opts.limit)}`,
    );
  }
  const windowMs = parseDuration(opts.window);
  return brand({ kind: 'sliding-window-log' as const, limit: opts.limit, windowMs });
}
