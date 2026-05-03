# with-express — `@devkit/ratelimit` sandbox

`expressRateLimit(limiter)` plugged in via `app.use(...)` on a real Express
app bound to an ephemeral port. The demo fires a burst through native
`fetch`, prints the resulting headers, sleeps 1.2 s for one token to
refill, then makes one final request to confirm the bucket recovers.

[![Open in StackBlitz](https://developer.stackblitz.com/img/open_in_stackblitz.svg)](https://stackblitz.com/github/j09822475-dev/devkit-ratelimit/tree/main/examples/sandbox/with-express)

## Run locally

```sh
npm install
npm start
```

## What it covers

- The Express adapter from `@devkit/ratelimit/frameworks/express`
- A token-bucket policy (`tokenBucket({ capacity: 4, refill: 1, interval: '1s' })`)
- Real HTTP traffic — Express binds, `fetch` calls in, `Retry-After` is read off the 429
- Recovery after a partial refill — the seventh request succeeds again
