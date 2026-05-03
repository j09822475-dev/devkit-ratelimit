import { describe, expect, it } from 'vitest';
import { buildHeaders } from '../core/headers.js';
import type { RateLimitState } from '../types/result.js';

const baseState = (over: Partial<RateLimitState> = {}): RateLimitState => ({
  limit: 100,
  remaining: 50,
  reset: 60_000,
  retryAfter: 0,
  ...over,
});

describe('buildHeaders', () => {
  it('should return an empty Headers object when style is "none"', () => {
    const h = buildHeaders(baseState(), 'none', 0);
    expect([...h.entries()]).toEqual([]);
  });

  it('should set RFC headers when style is "rfc"', () => {
    const h = buildHeaders(baseState({ reset: 60_000 }), 'rfc', 0);
    expect(h.get('RateLimit')).toBe('limit=100, remaining=50, reset=60');
    expect(h.get('RateLimit-Policy')).toBe('100;w=60');
    expect(h.get('X-RateLimit-Limit')).toBeNull();
  });

  it('should set legacy X-RateLimit headers when style is "legacy"', () => {
    const h = buildHeaders(baseState({ reset: 60_000 }), 'legacy', 0);
    expect(h.get('X-RateLimit-Limit')).toBe('100');
    expect(h.get('X-RateLimit-Remaining')).toBe('50');
    expect(h.get('X-RateLimit-Reset')).toBe('60');
    expect(h.get('RateLimit')).toBeNull();
  });

  it('should set both RFC and legacy headers when style is "both"', () => {
    const h = buildHeaders(baseState({ reset: 60_000 }), 'both', 0);
    expect(h.get('RateLimit')).toBeTruthy();
    expect(h.get('X-RateLimit-Limit')).toBe('100');
  });

  it('should add Retry-After header rounded up when retryAfter > 0', () => {
    const h = buildHeaders(baseState({ retryAfter: 1500 }), 'rfc', 0);
    expect(h.get('Retry-After')).toBe('2');
  });

  it('should not add Retry-After when retryAfter is 0', () => {
    const h = buildHeaders(baseState({ retryAfter: 0 }), 'rfc', 0);
    expect(h.get('Retry-After')).toBeNull();
  });

  it('should clamp negative reset delta to 0 when state.reset is in the past', () => {
    const h = buildHeaders(baseState({ reset: 1000 }), 'rfc', 5000);
    expect(h.get('RateLimit')).toBe('limit=100, remaining=50, reset=0');
  });

  it('should round up reset seconds when reset delta is fractional', () => {
    const h = buildHeaders(baseState({ reset: 5_500 }), 'rfc', 5_000);
    expect(h.get('RateLimit')).toContain('reset=1');
  });

  it('should derive RateLimit-Policy w from (reset - now) when reset is in the future', () => {
    const h = buildHeaders(baseState({ reset: 30_000 }), 'rfc', 0);
    expect(h.get('RateLimit-Policy')).toBe('100;w=30');
  });

  it('should deterministically use the supplied now (no Date.now leak)', () => {
    const h1 = buildHeaders(baseState({ reset: 70_000 }), 'rfc', 10_000);
    const h2 = buildHeaders(baseState({ reset: 70_000 }), 'rfc', 10_000);
    expect(h1.get('RateLimit')).toBe(h2.get('RateLimit'));
    expect(h1.get('RateLimit-Policy')).toBe(h2.get('RateLimit-Policy'));
  });

  it('should produce a fresh Headers object each call', () => {
    const a = buildHeaders(baseState(), 'rfc', 0);
    const b = buildHeaders(baseState(), 'rfc', 0);
    expect(a).not.toBe(b);
  });
});
