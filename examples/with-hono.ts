/**
 * with-hono.ts — Hono integration via the `honoRateLimit` middleware.
 *
 * Run:    npx tsx examples/with-hono.ts
 *
 * The example does NOT bind a port — it drives the Hono app directly via
 * `app.fetch(request)`, which is the same entrypoint Workers/Bun/Deno call.
 * That keeps the demo runnable in any environment without a free port.
 */

import { Hono } from 'hono';
import { createRateLimiter } from '@devkit/ratelimit';
import { createMemoryStore } from '@devkit/ratelimit/adapters/memory';
import { honoRateLimit } from '@devkit/ratelimit/frameworks/hono';

const limiter = createRateLimiter({
  algorithm: 'sliding-window',
  limit: 3,
  window: '10s',
  store: createMemoryStore(),
});

const app = new Hono();
app.use('*', honoRateLimit(limiter));
app.get('/', (c) => c.text('ok'));
app.get('/health', (c) => c.json({ status: 'up' }));

function fakeRequest(ip: string, path = '/'): Request {
  return new Request(`http://localhost${path}`, {
    method: 'GET',
    headers: { 'x-forwarded-for': ip },
  });
}

console.log('policy: 3 req / 10s — driving the Hono app via app.fetch()\n');

const ip = '203.0.113.42';
for (let i = 1; i <= 5; i++) {
  const res = await app.fetch(fakeRequest(ip));
  const body = await res.text();
  const live = res.headers.get('RateLimit') ?? '';
  const retryAfter = res.headers.get('Retry-After') ?? '-';
  console.log(
    `  ${i}) status=${res.status} body=${JSON.stringify(body)} ` +
      `[${live}] retry-after=${retryAfter}`,
  );
}

// A different IP gets its own quota — the limiter buckets per key.
console.log(`\nfresh IP gets a fresh bucket:`);
const res = await app.fetch(fakeRequest('198.51.100.5'));
console.log(
  `  status=${res.status} ${res.headers.get('RateLimit') ?? ''}`,
);
