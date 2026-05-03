/**
 * Internal invariant helper. Always throws a {@link RateLimitError} with a
 * stable code so the engine never raises a bare `Error`.
 */

import { RateLimitError } from '../errors/base.js';
import type { RateLimitErrorCode } from '../errors/codes.js';

/**
 * Assert a condition. Throws {@link RateLimitError} when `cond` is falsy.
 *
 * @param cond    Condition to assert.
 * @param code    Stable error code for the thrown error.
 * @param message Public, safe-to-log message (no secrets).
 * @throws        `RateLimitError` when `cond` is falsy.
 */
export function invariant(
  cond: unknown,
  code: RateLimitErrorCode,
  message: string,
): asserts cond {
  if (!cond) throw new RateLimitError(code, message);
}
