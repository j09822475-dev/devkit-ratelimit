# with-next — `@devkit/ratelimit` sandbox

`withRateLimit(limiter, handler)` wraps a Next.js App Router Route Handler
so `export const GET = withRateLimit(limiter, handler)` runs the limiter
before your code on every request. The demo calls the wrapped handler
directly with a `Request` so it works without an actual Next dev server.

[![Open in StackBlitz](https://developer.stackblitz.com/img/open_in_stackblitz.svg)](https://stackblitz.com/github/j09822475-dev/devkit-ratelimit/tree/main/examples/sandbox/with-next)

## Run locally

```sh
npm install
npm start
```

## What it covers

- The Next adapter from `@devkit/ratelimit/frameworks/next`
- A `fixed-window` policy (cheapest in storage; up to 2× burst at boundary)
- Calling the wrapped handler with a Web-Standard `Request` — same shape Next executes
- `RateLimit` headers merged into the success `Response`, plus a 429 with `Retry-After` on block

## Drop into a real Next app

```ts
// app/api/posts/route.ts
import { createRateLimiter } from '@devkit/ratelimit';
import { createMemoryStore } from '@devkit/ratelimit/adapters/memory';
import { withRateLimit } from '@devkit/ratelimit/frameworks/next';

const limiter = createRateLimiter({
  algorithm: 'fixed-window', limit: 3, window: '5s',
  store: createMemoryStore(),
});

export const GET = withRateLimit(limiter, async (req) =>
  Response.json({ ok: true }),
);
```
