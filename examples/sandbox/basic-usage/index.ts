import { createRateLimiter } from '@devkit/ratelimit';
import { createMemoryStore } from '@devkit/ratelimit/adapters/memory';

const limiter = createRateLimiter({
  algorithm: 'sliding-window',
  limit: 5,
  window: '10s',
  store: createMemoryStore(),
});

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
  const live = result.headers.get('RateLimit') ?? '';
  console.log(
    `  ${String(i).padStart(2)}) ${tag.padEnd(7)} ` +
      `remaining=${result.state.remaining} ` +
      `retryAfter=${result.state.retryAfter}ms ` +
      `[${live}]`,
  );
}

const snapshot = await limiter.peek(fakeRequest(ip));
console.log(
  `\npeek after the loop: remaining=${snapshot.state.remaining}, ` +
    `resetIn=${Math.max(0, snapshot.state.reset - Date.now())}ms`,
);

await limiter.reset(fakeRequest(ip));
const afterReset = await limiter.peek(fakeRequest(ip));
console.log(`after reset:        remaining=${afterReset.state.remaining}`);
