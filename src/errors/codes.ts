/**
 * Stable error code catalogue. Every {@link RateLimitError} carries one
 * of these codes so consumers can switch on them without parsing the
 * message.
 */

export const RATELIMIT_ERROR_CODES = [
  'INVALID_CONFIG',
  'INVALID_COST',
  'INVALID_KEY',
  'INVALID_TIER',
  'STORE_UNAVAILABLE',
  'WINDOW_TOO_LARGE',
  'PAYLOAD_TOO_LARGE',
  'KEY_TOO_LONG',
] as const;

/**
 * Stable error code catalogue. Every {@link RateLimitError} carries one
 * of these codes.
 */
export type RateLimitErrorCode = (typeof RATELIMIT_ERROR_CODES)[number];
