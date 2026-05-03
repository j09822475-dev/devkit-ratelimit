/**
 * with-express.ts — Express integration via `expressRateLimit`.
 *
 * Run:    npx tsx examples/with-express.ts
 *
 * The example binds Express to an ephemeral port, fires a few requests
 * through native `fetch`, prints the response shape, and shuts the server
 * down before exiting.
 */

import { AddressInfo } from 'node:net';
import express from 'express';
import { createRateLimiter } from '@devkit/ratelimit';
import { tokenBucket } from '@devkit/ratelimit/algorithms/token-bucket';
import { createMemoryStore } from '@devkit/ratelimit/adapters/memory';
import { expressRateLimit } from '@devkit/ratelimit/frameworks/express';

// Token bucket — capacity 4 with 1 token / sec refill. Lets a client burst
// up to 4 immediately, then settles to a steady drip.
const limiter = createRateLimiter({
  algorithm: tokenBucket({ capacity: 4, refill: 1, interval: '1s' }),
  store: createMemoryStore(),
});

const app = express();
app.set('trust proxy', true);
app.use(expressRateLimit(limiter));
app.get('/api/hello', (_req, res) => res.json({ ok: true }));

const server = app.listen(0);
const { port } = server.address() as AddressInfo;
console.log(`policy: capacity=4, refill=1/s — Express on http://localhost:${port}\n`);

async function fire(label: string) {
  const res = await fetch(`http://localhost:${port}/api/hello`, {
    headers: { 'x-forwarded-for': '203.0.113.99' },
  });
  const live = res.headers.get('ratelimit') ?? '';
  const retry = res.headers.get('retry-after') ?? '-';
  console.log(`  ${label.padEnd(10)} status=${res.status} [${live}] retry-after=${retry}`);
}

// Burn the burst capacity, then watch the next two get blocked.
for (let i = 1; i <= 6; i++) await fire(`req ${i}`);

// Sleep ~1.2s to let one token refill, then verify the limiter recovers.
await new Promise<void>((resolve) => setTimeout(resolve, 1_200));
await fire('after 1.2s wait');

server.close();
