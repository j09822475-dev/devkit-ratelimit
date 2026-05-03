/**
 * Errors subpath barrel. Importing this gives consumers the single
 * {@link RateLimitError} class plus the stable code catalogue.
 */

export { RateLimitError } from './base.js';
export { RATELIMIT_ERROR_CODES, type RateLimitErrorCode } from './codes.js';
