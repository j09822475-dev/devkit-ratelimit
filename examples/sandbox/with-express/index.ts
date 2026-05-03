import type { AddressInfo } from 'node:net';
import express from 'express';
import { createRateLimiter } from '@devkit/ratelimit';
import { tokenBucket } from '@devkit/ratelimit/algorithms/token-bucket';
import { createMemoryStore } from '@devkit/ratelimit/adapters/memory';
import { expressRateLimit } from '@devkit/ratelimit/frameworks/express';

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

for (let i = 1; i <= 6; i++) await fire(`req ${i}`);

await new Promise<void>((resolve) => setTimeout(resolve, 1_200));
await fire('after 1.2s wait');

server.close();
