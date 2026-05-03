/**
 * basic-usage.ts — minimal core functionality.
 *
 * Run:    npx tsx examples/basic-usage.ts
 *
 * Demonstrates:
 *   - Building a sliding-window limiter with the in-memory store
 *   - Calling `limiter.check(req)` against a Web-Standard `Request`
 *   - Reading the RFC `RateLimit` / `RateLimit-Policy` headers and
 *     `result.allowed` / `result.state.remaining`
 *   - Burning through the quota and observing the 429-style block
 */

import { createRateLimiter } from '@devkit/ratelimit';
import { createMemoryStore } from '@devkit/ratelimit/adapters/memory';

// 5 permits per 10 seconds — small enough to exhaust in a demo loop.
const limiter = createRateLimiter({
  algorithm: 'sliding-window',
  limit: 5,
  window: '10s',
  store: createMemoryStore(),
});

// Build a fake request whose `x-forwarded-for` header drives the default
// key generator — same effect as a real client behind a proxy.
function fakeRequest(ip: string, path = '/api/hello'): Request {
  return new Request(`https://example.com${path}`, {
    method: 'GET',
    headers: { 'x-forwarded-for': ip },
  });
}

const ip = '203.0.113.7';

console.log(`policy: 5 req / 10s — sending 7 requests from ${ip}\n`);

for (let i = 1; i <= 7; i++) {
  const result = await limiter.check(fakeRequest(ip));
  const tag = result.allowed ? 'allowed' : 'BLOCKED';
  const policy = result.headers.get('RateLimit-Policy') ?? '';
  const live = result.headers.get('RateLimit') ?? '';
  console.log(
    `  ${String(i).padStart(2)}) ${tag.padEnd(7)} ` +
      `remaining=${result.state.remaining} ` +
      `retryAfter=${result.state.retryAfter}ms ` +
      `[${live} | ${policy}]`,
  );
}

// `peek` inspects the bucket without consuming a permit.
const snapshot = await limiter.peek(fakeRequest(ip));
console.log(
  `\npeek after the loop: remaining=${snapshot.state.remaining}, ` +
    `resetIn=${Math.max(0, snapshot.state.reset - Date.now())}ms`,
);

// `reset` clears the bucket — useful when an ops engineer flushes a
// runaway client by hand.
await limiter.reset(fakeRequest(ip));
const afterReset = await limiter.peek(fakeRequest(ip));
console.log(`after reset:        remaining=${afterReset.state.remaining}`);
