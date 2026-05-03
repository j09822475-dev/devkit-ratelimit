/**
 * Fastify plugin — registered as `onRequest` so the limiter runs before
 * body parsers. Same Express-style shim under the hood.
 */

import type { RateLimiter } from '../../types/limiter.js';

/**
 * Loose Fastify request shape.
 */
export interface FastifyReqLike {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  ip?: string;
}

/**
 * Loose Fastify reply shape.
 */
export interface FastifyReplyLike {
  code(status: number): FastifyReplyLike;
  header(name: string, value: string): FastifyReplyLike;
  send(body?: string): void | Promise<void>;
}

/**
 * Build a Fastify-compatible `onRequest` hook.
 *
 * @typeParam K Caller-defined context payload type.
 * @param limiter The {@link RateLimiter} handle.
 * @returns       A Fastify hook function.
 * @example
 *   import { fastifyRateLimit } from '@devkit/ratelimit/frameworks/fastify';
 *   fastify.addHook('onRequest', fastifyRateLimit(limiter));
 */
export function fastifyRateLimit<K = undefined>(limiter: RateLimiter<K>) {
  return async (req: FastifyReqLike, reply: FastifyReplyLike): Promise<void> => {
    const webReq = fastifyReqToWeb(req);
    const result = await limiter.check(webReq);
    result.headers.forEach((v, k) => {
      reply.header(k, v);
    });
    if (!result.allowed) {
      reply.code(429);
      await reply.send('Too Many Requests');
    }
  };
}

function fastifyReqToWeb(req: FastifyReqLike): Request {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const v of value) headers.append(key, v);
    } else {
      headers.set(key, value);
    }
  }
  const host = headers.get('host') ?? 'localhost';
  const proto = headers.get('x-forwarded-proto') ?? 'http';
  const url = `${proto}://${host}${req.url}`;
  return new Request(url, { method: req.method, headers });
}
