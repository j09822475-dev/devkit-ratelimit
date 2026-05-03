# advanced-usage — `@devkit/ratelimit` sandbox

Realistic AI/SaaS scenario layering several `@devkit/ratelimit` primitives:

- A **token-bucket** policy per API plan (free / pro / enterprise) — burst-friendly for LLM endpoints
- **`tieredRateLimiter`** — picks the right bucket per request based on the API key's plan
- **`composeAll`** — AND-composes a per-IP backstop ON TOP of the per-plan limiter so abusive IPs can't burn through any one tenant's budget
- A **structured key generator** threading a typed `{ tenant, plan }` context through to the result and observability events
- An **observability hook** logging block/skip events with the layer that produced them

[![Open in StackBlitz](https://developer.stackblitz.com/img/open_in_stackblitz.svg)](https://stackblitz.com/github/j09822475-dev/devkit-ratelimit/tree/main/examples/sandbox/advanced-usage)

## Run locally

```sh
npm install
npm start
```

## What you'll see

Three scripted scenarios run back-to-back:

1. A **free-tier** client bursts six requests at a 3-token bucket — three are allowed, three are blocked, with the per-tier hook firing on each block.
2. A **pro-tier** client cruises through six requests against its 30-token bucket — all allowed, no hooks fired.
3. A **shared abusive IP** spams 60 requests in tight succession; the per-IP layer blocks everything past the 50-per-minute backstop, *before* the plan limiter ever sees them.
