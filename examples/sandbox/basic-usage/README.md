# basic-usage — `@devkit/ratelimit` sandbox

Minimal demo of the core API: build a sliding-window limiter, fire seven
requests against a 5-per-10-seconds policy, watch the `RateLimit` headers
update and the bucket flip from `allowed` to `BLOCKED` after the fifth.

[![Open in StackBlitz](https://developer.stackblitz.com/img/open_in_stackblitz.svg)](https://stackblitz.com/github/j09822475-dev/devkit-ratelimit/tree/main/examples/sandbox/basic-usage)

## Run locally

```sh
npm install
npm start
```

## What it covers

- `createRateLimiter({ algorithm: 'sliding-window', limit, window, store })` — sugar form
- `createMemoryStore()` — single-process LRU
- `limiter.check(req)` — the main allow/block decision, returns `{ allowed, state, headers }`
- `limiter.peek(req)` — inspect without consuming
- `limiter.reset(req)` — clear a bucket (useful for ops tooling)
- Reading the RFC `RateLimit` / `RateLimit-Policy` headers off `result.headers`
