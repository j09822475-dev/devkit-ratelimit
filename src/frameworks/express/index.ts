/**
 * Express adapter — translates `(req, res, next)` to a Web-Standard
 * `Request` so the limiter does not need a Node-specific code path. The
 * shim is small but covers the awkward bits: `req.headers` may be
 * `undefined` on legacy Express ≤3, and `req.url` is path-only.
 */

import type { RateLimiter } from '../../types/limiter.js';

/**
 * Minimum Express request shape required by the adapter.
 */
export interface ExpressReqLike {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  socket?: { remoteAddress?: string };
  ip?: string;
}

/**
 * Minimum Express response shape required by the adapter.
 */
export interface ExpressResLike {
  statusCode: number;
  setHeader(name: string, value: string): void;
  end(body?: string): void;
}

/**
 * Build an Express middleware. Forwards on allow; ends the response with a
 * 429 (and the limiter's headers) on block.
 *
 * @typeParam K Caller-defined context payload type.
 * @param limiter The {@link RateLimiter} handle.
 * @returns       An Express-style `(req, res, next)` middleware.
 * @example
 *   import { expressRateLimit } from '@devkit/ratelimit/frameworks/express';
 *   app.use(expressRateLimit(limiter));
 */
export function expressRateLimit<K = undefined>(limiter: RateLimiter<K>) {
  return async (
    req: ExpressReqLike,
    res: ExpressResLike,
    next: (err?: unknown) => void,
  ): Promise<void> => {
    try {
      const webReq = expressReqToWeb(req);
      const result = await limiter.check(webReq);
      result.headers.forEach((v, k) => res.setHeader(k, v));
      if (!result.allowed) {
        res.statusCode = 429;
        res.end('Too Many Requests');
        return;
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

/**
 * Build a Web-Standard `Request` from an Express request. We only need
 * the URL, method and headers; bodies are not required by the limiter.
 *
 * @param req Express request.
 * @returns   A `Request` carrying the URL, method, and headers.
 */
function expressReqToWeb(req: ExpressReqLike): Request {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const v of value) headers.append(key, v);
    } else {
      headers.set(key, value);
    }
  }
  // Express `req.url` is path+query; we synthesise a host so `new URL`
  // accepts it. `localhost` is fine because the limiter only consults
  // `pathname` for observability.
  const host = headers.get('host') ?? 'localhost';
  const proto =
    headers.get('x-forwarded-proto') ?? 'http';
  const url = `${proto}://${host}${req.url}`;
  return new Request(url, { method: req.method, headers });
}
