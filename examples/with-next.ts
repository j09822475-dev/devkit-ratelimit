/**
 * with-next.ts — Next.js App Router integration via `withRateLimit`.
 *
 * Run:    npx tsx examples/with-next.ts
 *
 * Real Next routes export a `GET` handler from `app/api/.../route.ts`.
 * `withRateLimit(limiter, handler)` wraps a Web-Standard
 * `(Request) => Response` handler — exactly what App Router executes — so
 * the demo can call the wrapped handler directly with a `Request` and read
 * back the same `Response` Next would return to the browser.
 */

import { createRateLimiter } from '@devkit/ratelimit';
import { createMemoryStore } from '@devkit/ratelimit/adapters/memory';
import { withRateLimit } from '@devkit/ratelimit/frameworks/next';

const limiter = createRateLimiter({
  algorithm: 'fixed-window',
  limit: 3,
  window: '5s',
  store: createMemoryStore(),
});

// Hypothetical Next.js route handler — `withRateLimit` returns a wrapped
// handler with the same shape, suitable for `export const GET = ...`.
const handler = async (req: Request): Promise<Response> => {
  const url = new URL(req.url);
  return Response.json({ route: url.pathname, method: req.method, ok: true });
};
const GET = withRateLimit(limiter, handler);

function fakeRequest(ip: string): Request {
  return new Request('http://localhost:3000/api/posts', {
    method: 'GET',
    headers: { 'x-forwarded-for': ip },
  });
}

console.log('policy: 3 req / 5s (fixed window) — calling the wrapped GET handler\n');

const ip = '203.0.113.55';
for (let i = 1; i <= 5; i++) {
  const res = await GET(fakeRequest(ip));
  const live = res.headers.get('RateLimit') ?? '';
  const body = res.status === 200 ? await res.json() : await res.text();
  console.log(
    `  ${i}) status=${res.status} body=${JSON.stringify(body)} [${live}]`,
  );
}
