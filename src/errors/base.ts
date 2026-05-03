/**
 * Base error class for every failure mode the limiter surfaces. The
 * `code` field is stable and safe to switch on; the optional `cause` is
 * preserved for debugging and never serialised by `publicMessage`.
 */

import type { RateLimitErrorCode } from './codes.js';

/**
 * The single error class the public API throws. Carries a stable
 * {@link RateLimitErrorCode} so consumers can switch on the failure mode
 * without parsing the message.
 *
 * `RateLimitError.is(value)` works across realm boundaries (Workers ↔
 * Durable Objects), where `instanceof` fails, by checking
 * `name === 'RateLimitError'` and the presence of a `code` field.
 *
 * @example
 *   try {
 *     await limiter.check(req);
 *   } catch (err) {
 *     if (RateLimitError.is(err) && err.code === 'STORE_UNAVAILABLE') {
 *       // … route to fallback store
 *     }
 *     throw err;
 *   }
 */
export class RateLimitError extends Error {
  override readonly name = 'RateLimitError';

  /** Stable error code — switch on this, not the message. */
  readonly code: RateLimitErrorCode;

  /** Original cause when wrapping store / network errors. */
  override readonly cause?: unknown;

  /** Safe-to-log message — never includes raw user input or secrets. */
  readonly publicMessage: string;

  /**
   * Construct a new error.
   *
   * @param code    Stable error code.
   * @param message Public, safe-to-log message (no secrets).
   * @param cause   Optional original cause for debugging.
   */
  constructor(code: RateLimitErrorCode, message: string, cause?: unknown) {
    super(message);
    this.code = code;
    this.publicMessage = message;
    if (cause !== undefined) this.cause = cause;
  }

  /**
   * Cross-realm-safe type guard. Use this instead of `instanceof` when the
   * error may have crossed a Workers ↔ Durable Object boundary.
   *
   * @param value Any value.
   * @returns     `true` iff the value looks like a `RateLimitError`.
   */
  static is(value: unknown): value is RateLimitError {
    if (value === null || typeof value !== 'object') return false;
    const candidate = value as { name?: unknown; code?: unknown };
    return candidate.name === 'RateLimitError' && typeof candidate.code === 'string';
  }
}
