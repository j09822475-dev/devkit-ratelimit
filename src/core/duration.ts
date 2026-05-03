/**
 * Duration parsing — accepts `number` (ms), template-literal strings
 * (`'1m'`, `'500 ms'`), and the object form. Normalises to integer
 * milliseconds at construction time so the store never sees a string.
 */

import { RateLimitError } from '../errors/base.js';
import type { Duration } from '../types/runtime.js';

const UNIT_MS = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
} as const;

const STRING_RE = /^([0-9]+)\s?(ms|s|m|h|d)$/;

/**
 * Parse a {@link Duration} into integer milliseconds. Defence-in-depth:
 * the runtime regex re-validates string inputs even though the template
 * literal type already rejects decimals at the call site (a consumer
 * passing a widened `string` would otherwise sneak past the type check).
 *
 * @param value Duration value.
 * @returns     Integer milliseconds (always &gt; 0).
 * @throws      `RateLimitError('INVALID_CONFIG')` on invalid input.
 * @example
 *   parseDuration('1m');           // 60_000
 *   parseDuration(60_000);         // 60_000
 *   parseDuration({ minutes: 1 }); // 60_000
 */
export function parseDuration(value: Duration): number {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0 || !Number.isInteger(value)) {
      throw new RateLimitError(
        'INVALID_CONFIG',
        `duration must be a positive integer ms, got ${String(value)}`,
      );
    }
    return value;
  }
  if (typeof value === 'string') {
    const match = STRING_RE.exec(value);
    if (match === null) {
      throw new RateLimitError(
        'INVALID_CONFIG',
        `invalid duration string '${value}' — expected '<int>[ms|s|m|h|d]'`,
      );
    }
    const amount = Number(match[1]);
    const unit = match[2] as keyof typeof UNIT_MS;
    const ms = amount * UNIT_MS[unit];
    if (!Number.isFinite(ms) || ms <= 0) {
      throw new RateLimitError(
        'INVALID_CONFIG',
        `duration '${value}' resolves to a non-positive value`,
      );
    }
    return ms;
  }
  if (typeof value === 'object' && value !== null) {
    const ms =
      (value.milliseconds ?? 0) +
      (value.seconds ?? 0) * UNIT_MS.s +
      (value.minutes ?? 0) * UNIT_MS.m +
      (value.hours ?? 0) * UNIT_MS.h +
      (value.days ?? 0) * UNIT_MS.d;
    if (!Number.isFinite(ms) || ms <= 0) {
      throw new RateLimitError(
        'INVALID_CONFIG',
        `duration object resolves to a non-positive value`,
      );
    }
    // Object form may produce fractional ms (e.g. { minutes: 1.5 }); we
    // truncate so the store always sees an integer.
    return Math.floor(ms);
  }
  throw new RateLimitError(
    'INVALID_CONFIG',
    `duration must be a number, string or object, got ${typeof value}`,
  );
}
