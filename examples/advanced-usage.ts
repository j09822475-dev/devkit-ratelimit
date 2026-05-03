/**
 * advanced-usage.ts — a realistic AI/SaaS scenario.
 *
 * Run:    npx tsx examples/advanced-usage.ts
 *
 * Demonstrates, end-to-end:
 *   1. Token-bucket policy for an LLM endpoint (burst-friendly, steady refill).
 *   2. Tiered limits — `free` / `pro` / `enterprise` plans backed by separate
 *      buckets, picked per request from an `x-api-key` header.
 *   3. `composeAll` AND-composition layering a per-IP guard ON TOP of the
 *      per-API-key plan limiter, so abusive IPs can't burn through any one
 *      tenant's budget.
 *   4. A structured key generator threading a typed `{ tenant, plan }`
 *      context through to the result.
 *   5. An observability hook (`hookMode: 'sync'` so the demo log lines
 *      print in deterministic order) emitting allow/block events.
 */

import { createRateLimiter } from '@devkit/ratelimit';
import type { RateLimitObservation } from '@devkit/ratelimit';
import { tokenBucket } from '@devkit/ratelimit/algorithms/token-bucket';
import { slidingWindow } from '@devkit/ratelimit/algorithms/sliding-window';
import { createMemoryStore } from '@devkit/ratelimit/adapters/memory';
import { composeAll } from '@devkit/ratelimit/compose';
import { tieredRateLimiter } from '@devkit/ratelimit/compose';

interface KeyContext {
  readonly tenant: string;
  readonly plan: 'free' | 'pro' | 'enterprise';
}

const sharedStore = createMemoryStore();

// Light hook used by every limiter below — tag each event with the layer
// name so we can see which one allowed or blocked.
function makeHook(layer: string) {
  return (event: RateLimitObservation<unknown>): void => {
    if (event.type === 'rate-limit.allowed') return; // keep the log terse
    const ctx = event.context as KeyContext | undefined;
    const tag = ctx !== undefined ? `${ctx.plan}/${ctx.tenant}` : event.key;
    console.log(
      `  hook[${layer}] ${event.type.replace('rate-limit.', '')} ` +
        `key=${tag} remaining=${event.state.remaining}`,
    );
  };
}

// ------------------------------------------------------------------
// Layer 1 — per-API-key, plan-aware token-bucket policies.
// ------------------------------------------------------------------
const freeLimiter = createRateLimiter<KeyContext>({
  algorithm: tokenBucket({ capacity: 3, refill: 1, interval: '1s' }),
  store: sharedStore,
  prefix: 'rl:llm:free',
  keyGenerator: keyByApiKey,
  on: makeHook('free'),
  hookMode: 'sync',
});

const proLimiter = createRateLimiter<KeyContext>({
  algorithm: tokenBucket({ capacity: 30, refill: 10, interval: '1s' }),
  store: sharedStore,
  prefix: 'rl:llm:pro',
  keyGenerator: keyByApiKey,
  on: makeHook('pro'),
  hookMode: 'sync',
});

const enterpriseLimiter = createRateLimiter<KeyContext>({
  algorithm: tokenBucket({ capacity: 1_000, refill: 100, interval: '1s' }),
  store: sharedStore,
  prefix: 'rl:llm:ent',
  keyGenerator: keyByApiKey,
  on: makeHook('enterprise'),
  hookMode: 'sync',
});

const planLimiter = tieredRateLimiter({
  resolve: (req) => planFromRequest(req),
  tiers: { free: freeLimiter, pro: proLimiter, enterprise: enterpriseLimiter },
});

// ------------------------------------------------------------------
// Layer 2 — per-IP backstop in front of the plan limiter.
// `composeAll` runs both layers in order; either one blocking returns 429.
// ------------------------------------------------------------------
const ipLimiter = createRateLimiter({
  algorithm: slidingWindow({ limit: 50, window: '1m' }),
  store: sharedStore,
  prefix: 'rl:llm:ip',
  on: makeHook('ip'),
  hookMode: 'sync',
});

const guard = composeAll([ipLimiter, planLimiter]);

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------
function keyByApiKey(req: Request): { key: string; context: KeyContext } | null {
  const key = req.headers.get('x-api-key');
  if (key === null || key === '') return null;
  const tenant = key.split('_')[1] ?? 'unknown';
  return { key, context: { tenant, plan: planFromKey(key) } };
}

function planFromKey(apiKey: string): KeyContext['plan'] {
  if (apiKey.startsWith('ent_')) return 'enterprise';
  if (apiKey.startsWith('pro_')) return 'pro';
  return 'free';
}

function planFromRequest(req: Request): KeyContext['plan'] {
  return planFromKey(req.headers.get('x-api-key') ?? '');
}

function fakeRequest(apiKey: string, ip: string): Request {
  return new Request('https://api.example.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'x-forwarded-for': ip,
      'content-type': 'application/json',
    },
  });
}

// ------------------------------------------------------------------
// Demo
// ------------------------------------------------------------------
async function fire(label: string, apiKey: string, ip: string, n: number) {
  console.log(`\n--- ${label} (${n} requests, key=${apiKey}, ip=${ip}) ---`);
  let allowed = 0;
  let blocked = 0;
  for (let i = 0; i < n; i++) {
    const result = await guard.check(fakeRequest(apiKey, ip));
    if (result.allowed) allowed++;
    else blocked++;
  }
  console.log(`  totals: allowed=${allowed} blocked=${blocked}`);
}

await fire('free-tier client bursts past its 3-token bucket', 'free_acme', '203.0.113.1', 6);
await fire('pro-tier client cruises through its 30-token bucket', 'pro_globex', '203.0.113.2', 6);
await fire('shared abusive IP hits the 50/min IP backstop', 'ent_initech', '198.51.100.99', 60);
