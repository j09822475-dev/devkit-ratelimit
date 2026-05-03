import { createRateLimiter } from '@devkit/ratelimit';
import type { RateLimitObservation } from '@devkit/ratelimit';
import { tokenBucket } from '@devkit/ratelimit/algorithms/token-bucket';
import { slidingWindow } from '@devkit/ratelimit/algorithms/sliding-window';
import { createMemoryStore } from '@devkit/ratelimit/adapters/memory';
import { composeAll, tieredRateLimiter } from '@devkit/ratelimit/compose';

interface KeyContext {
  readonly tenant: string;
  readonly plan: 'free' | 'pro' | 'enterprise';
}

const sharedStore = createMemoryStore();

function makeHook(layer: string) {
  return (event: RateLimitObservation<unknown>): void => {
    if (event.type === 'rate-limit.allowed') return;
    const ctx = event.context as KeyContext | undefined;
    const tag = ctx !== undefined ? `${ctx.plan}/${ctx.tenant}` : event.key;
    console.log(
      `  hook[${layer}] ${event.type.replace('rate-limit.', '')} ` +
        `key=${tag} remaining=${event.state.remaining}`,
    );
  };
}

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

const ipLimiter = createRateLimiter({
  algorithm: slidingWindow({ limit: 50, window: '1m' }),
  store: sharedStore,
  prefix: 'rl:llm:ip',
  on: makeHook('ip'),
  hookMode: 'sync',
});

const guard = composeAll([ipLimiter, planLimiter]);

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
