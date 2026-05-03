import { describe, expect, it } from 'vitest';
import { build429Response } from '../core/response.js';
import type { RateLimitResult } from '../types/result.js';

const result: RateLimitResult<undefined> = {
  allowed: false,
  key: 'k',
  state: { limit: 10, remaining: 0, reset: 1000, retryAfter: 1000 },
  headers: new Headers({ 'X-RateLimit-Limit': '10' }),
  degraded: false,
  context: undefined,
};

describe('build429Response', () => {
  it('should return a 429 Response with text/plain body', async () => {
    const res = build429Response(result, 'Too Many Requests');
    expect(res.status).toBe(429);
    expect(res.headers.get('Content-Type')).toMatch(/text\/plain/);
    expect(await res.text()).toBe('Too Many Requests');
  });

  it('should propagate result.headers onto the response', () => {
    const res = build429Response(result, 'Slow down');
    expect(res.headers.get('X-RateLimit-Limit')).toBe('10');
  });

  it('should clone headers so caller mutation does not affect the response', () => {
    const r = {
      ...result,
      headers: new Headers({ 'X-Custom': 'v1' }),
    };
    const res = build429Response(r, 'msg');
    r.headers.set('X-Custom', 'mutated');
    expect(res.headers.get('X-Custom')).toBe('v1');
  });
});
