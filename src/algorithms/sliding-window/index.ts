/**
 * Sliding-window counter — approximates a true sliding window by
 * interpolating between two adjacent fixed windows. Worst-case ~1%
 * overshoot; cost is two integer counters per key per window. The right
 * default for 99% of API rate limiting.
 */

import { parseDuration } from '../../core/duration.js';
import { RateLimitError } from '../../errors/base.js';
import type { SlidingWindowCounterSpec } from '../../types/algorithm.js';
import { brand } from '../../types/algorithm.js';
import type { Duration } from '../../types/runtime.js';

/**
 * Build a sliding-window counter spec.
 *
 * @param opts.limit  Maximum number of permits per `window`. MUST be a
 *                    positive finite integer.
 * @param opts.window Window length — accepts `Duration` (`'1m'`, `60_000`,
 *                    `{ minutes: 1 }`). Resolves to ≥ 1 ms.
 * @returns           A branded {@link SlidingWindowCounterSpec}.
 * @throws            `RateLimitError('INVALID_CONFIG')` on bad input.
 * @example
 *   const spec = slidingWindow({ limit: 100, window: '1m' });
 */
export function slidingWindow(opts: {
  readonly limit: number;
  readonly window: Duration;
}): SlidingWindowCounterSpec {
  if (
    typeof opts.limit !== 'number' ||
    !Number.isFinite(opts.limit) ||
    !Number.isInteger(opts.limit) ||
    opts.limit <= 0
  ) {
    throw new RateLimitError(
      'INVALID_CONFIG',
      `slidingWindow.limit must be a positive integer, got ${String(opts.limit)}`,
    );
  }
  const windowMs = parseDuration(opts.window);
  return brand({ kind: 'sliding-window-counter' as const, limit: opts.limit, windowMs });
}
