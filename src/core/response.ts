/**
 * Default 429 response builder. Used by `limiter.middleware()` when no
 * custom `responseBuilder` is supplied.
 */

import type { RateLimitResult } from '../types/result.js';

/**
 * Build a default `text/plain` 429 response carrying the headers from
 * the rate-limit result.
 *
 * @param result  The rate-limit result.
 * @param message Plain-text body.
 * @returns       A `Response` object with status 429.
 */
export function build429Response<K>(result: RateLimitResult<K>, message: string): Response {
  // Clone the headers so the caller can keep mutating their copy without
  // affecting the response.
  const headers = new Headers(result.headers);
  headers.set('Content-Type', 'text/plain; charset=utf-8');
  return new Response(message, { status: 429, headers });
}
