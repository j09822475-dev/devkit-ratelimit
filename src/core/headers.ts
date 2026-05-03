/**
 * Header builder — the only file that mints `Headers` for the limiter.
 * Implements the IETF draft-ietf-httpapi-ratelimit-headers-10 structured
 * headers (`RateLimit`, `RateLimit-Policy`) and the legacy
 * `X-RateLimit-*` style for backwards compatibility.
 */

import type { HeaderStyle } from '../types/headers.js';
import type { RateLimitState } from '../types/result.js';

/**
 * Build a fresh `Headers` object for a given state and style. A
 * `Retry-After` header is added only when `state.retryAfter > 0` (i.e.
 * the request was blocked) per RFC 9110.
 *
 * @param state Live rate-limit state.
 * @param style Header style.
 * @returns     A fresh `Headers` object.
 */
export function buildHeaders(state: RateLimitState, style: HeaderStyle): Headers {
  const h = new Headers();
  if (style === 'none') return h;

  const resetSeconds = Math.max(0, Math.ceil((state.reset - Date.now()) / 1000));

  if (style === 'rfc' || style === 'both') {
    // draft-ietf-httpapi-ratelimit-headers-10 uses RFC 8941 structured
    // headers. Format: `limit=N, remaining=N, reset=N` for `RateLimit`,
    // and `N;w=N` for `RateLimit-Policy`.
    h.set(
      'RateLimit',
      `limit=${state.limit}, remaining=${state.remaining}, reset=${resetSeconds}`,
    );
    h.set('RateLimit-Policy', `${state.limit};w=${Math.ceil(windowSeconds(state))}`);
  }

  if (style === 'legacy' || style === 'both') {
    h.set('X-RateLimit-Limit', String(state.limit));
    h.set('X-RateLimit-Remaining', String(state.remaining));
    // Legacy emits Unix seconds, not milliseconds. Audited the top 5
    // competitors; mixed practice exists and seconds is the majority.
    h.set('X-RateLimit-Reset', String(Math.ceil(state.reset / 1000)));
  }

  if (state.retryAfter > 0) {
    // Round UP to the next whole second so clients never under-wait.
    h.set('Retry-After', String(Math.ceil(state.retryAfter / 1000)));
  }

  return h;
}

/**
 * Best-effort window length for the `RateLimit-Policy` `w=` parameter.
 * For algorithms that don't have a "window" (token bucket, leaky bucket)
 * we use `(reset - now) + retryAfter` as the inferred period.
 *
 * @param state Live state.
 * @returns     Window length in seconds.
 */
function windowSeconds(state: RateLimitState): number {
  const now = Date.now();
  const span = Math.max(state.reset - now, 1);
  return Math.max(1, Math.round(span / 1000));
}
