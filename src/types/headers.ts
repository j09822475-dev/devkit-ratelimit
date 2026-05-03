/**
 * Header style + builder types.
 */

import type { RateLimitState } from './result.js';

/**
 * Header style applied to {@link RateLimitResult.headers}.
 *
 * - `'rfc'` — IETF draft-ietf-httpapi-ratelimit-headers-10 (`RateLimit`,
 *   `RateLimit-Policy` structured headers per RFC 8941).
 * - `'legacy'` — `X-RateLimit-Limit`, `X-RateLimit-Remaining`,
 *   `X-RateLimit-Reset` (Unix seconds).
 * - `'both'` — emit both styles for mixed-client compatibility.
 * - `'none'` — emit nothing; consumers build headers themselves from
 *   `result.state`.
 */
export type HeaderStyle = 'rfc' | 'legacy' | 'both' | 'none';

/**
 * Build a fresh `Headers` object pre-filled with the configured style. A
 * `Retry-After` header is added only when `state.retryAfter > 0` (i.e. the
 * request was blocked) per RFC 9110.
 *
 * @param state Live rate-limit state.
 * @param style Header style to apply.
 * @returns     A fresh `Headers` object.
 */
export type HeaderBuilder = (state: RateLimitState, style: HeaderStyle) => Headers;
