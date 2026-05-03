/**
 * Fixed window — `limit` permits per aligned wall-clock window. Cheapest
 * to implement (a single atomic INCR + EXPIRE in Redis) but allows up to
 * 2N requests across a window boundary in the worst case.
 */

import { parseDuration } from '../../core/duration.js';
import { RateLimitError } from '../../errors/base.js';
import type { FixedWindowSpec } from '../../types/algorithm.js';
import { brand } from '../../types/algorithm.js';
import type { Duration } from '../../types/runtime.js';

/**
 * Build a fixed-window spec.
 *
 * @param opts.limit  Maximum permits per aligned window. Positive integer.
 * @param opts.window Window length.
 * @returns           A branded {@link FixedWindowSpec}.
 * @throws            `RateLimitError('INVALID_CONFIG')` on bad input.
 * @example
 *   const spec = fixedWindow({ limit: 60, window: '1m' });
 */
export function fixedWindow(opts: {
  readonly limit: number;
  readonly window: Duration;
}): FixedWindowSpec {
  if (
    typeof opts.limit !== 'number' ||
    !Number.isFinite(opts.limit) ||
    !Number.isInteger(opts.limit) ||
    opts.limit <= 0
  ) {
    throw new RateLimitError(
      'INVALID_CONFIG',
      `fixedWindow.limit must be a positive integer, got ${String(opts.limit)}`,
    );
  }
  const windowMs = parseDuration(opts.window);
  return brand({ kind: 'fixed-window' as const, limit: opts.limit, windowMs });
}
