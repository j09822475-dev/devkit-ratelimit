# with-hono — `@devkit/ratelimit` sandbox

`honoRateLimit(limiter)` plugged in via `app.use('*', ...)`. The demo
drives the Hono app via `app.fetch(request)` so the same code that runs
on Cloudflare Workers / Vercel Edge / Deno / Bun runs verbatim here on
plain Node.

[![Open in StackBlitz](https://developer.stackblitz.com/img/open_in_stackblitz.svg)](https://stackblitz.com/github/j09822475-dev/devkit-ratelimit/tree/main/examples/sandbox/with-hono)

## Run locally

```sh
npm install
npm start
```

## What it covers

- The Hono adapter from `@devkit/ratelimit/frameworks/hono`
- `app.fetch(request)` as a portable, framework-agnostic test entrypoint
- Live `RateLimit` / `Retry-After` headers on both 200 and 429 responses
- Per-key bucketing — a fresh `x-forwarded-for` header gets a fresh bucket
