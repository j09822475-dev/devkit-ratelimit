import { describe, expect, it, vi } from 'vitest';
import { createMemoryStore } from '../adapters/memory/index.js';
import { fixedWindow } from '../algorithms/fixed-window/index.js';
import { createRateLimiter } from '../core/limiter.js';
import { elysiaRateLimit } from '../frameworks/elysia/index.js';
import { expressRateLimit } from '../frameworks/express/index.js';
import { fastifyRateLimit } from '../frameworks/fastify/index.js';
import { honoRateLimit } from '../frameworks/hono/index.js';
import { rateLimitMiddleware, withRateLimit } from '../frameworks/next/index.js';
import { rateLimitHandle } from '../frameworks/sveltekit/index.js';

const make = (limit = 1) =>
  createRateLimiter({
    algorithm: fixedWindow({ limit, window: '1m' }),
    store: createMemoryStore({ sweepIntervalMs: 0 }),
    clock: () => 0,
  });

const ipReq = (ip = '1.1.1.1'): Request =>
  new Request('https://example.com/test', { headers: { 'x-real-ip': ip } });

describe('honoRateLimit', () => {
  const buildContext = () => {
    const store = new Map<string, unknown>();
    let res: Response | undefined;
    const ctx = {
      req: { raw: ipReq() },
      get res() {
        return res;
      },
      set res(v) {
        res = v;
      },
      set(key: string, value: unknown) {
        store.set(key, value);
      },
      get(key: string): unknown {
        return store.get(key);
      },
    };
    return ctx;
  };

  it('should call next when allowed', async () => {
    const limiter = make(2);
    const middleware = honoRateLimit(limiter);
    const ctx = buildContext();
    const next = vi.fn().mockResolvedValue(undefined);
    const r = await middleware(ctx as never, next);
    expect(next).toHaveBeenCalled();
    expect(r).toBeUndefined();
  });

  it('should return a 429 Response when blocked', async () => {
    const limiter = make(1);
    const middleware = honoRateLimit(limiter);
    const ctx = buildContext();
    await middleware(ctx as never, vi.fn().mockResolvedValue(undefined));
    const ctx2 = buildContext();
    const blocked = await middleware(ctx2 as never, vi.fn());
    expect(blocked).toBeInstanceOf(Response);
    expect((blocked as Response).status).toBe(429);
  });

  it('should call onLimit override when blocked', async () => {
    const limiter = make(1);
    const onLimit = vi
      .fn()
      .mockReturnValue(new Response('custom', { status: 418 }));
    const middleware = honoRateLimit(limiter, { onLimit });
    await middleware(buildContext() as never, vi.fn());
    const r = await middleware(buildContext() as never, vi.fn());
    expect(onLimit).toHaveBeenCalled();
    expect((r as Response).status).toBe(418);
  });

  it('should set rateLimit on the context', async () => {
    const limiter = make(2);
    const middleware = honoRateLimit(limiter);
    const ctx = buildContext();
    await middleware(ctx as never, vi.fn().mockResolvedValue(undefined));
    expect(ctx.get('rateLimit')).toBeDefined();
  });

  it('should merge limiter headers into downstream response', async () => {
    const limiter = make(2);
    const middleware = honoRateLimit(limiter);
    const ctx = buildContext();
    const next = vi.fn().mockImplementation(async () => {
      ctx.res = new Response('ok');
    });
    await middleware(ctx as never, next);
    expect(ctx.res!.headers.get('RateLimit')).toBeTruthy();
  });

  it('should rebind the limiter via withExecutionCtx when ctx provides executionCtx', async () => {
    const inner = make(2);
    let capturedCtx: unknown = null;
    const wrapped = {
      ...inner,
      withExecutionCtx(ctx: { waitUntil(p: Promise<unknown>): void }) {
        capturedCtx = ctx;
        return inner.withExecutionCtx(ctx);
      },
    };
    const middleware = honoRateLimit(wrapped);
    const exec = { waitUntil: () => undefined };
    const ctx = { ...buildContext(), executionCtx: exec };
    await middleware(ctx as never, vi.fn().mockResolvedValue(undefined));
    expect(capturedCtx).toBe(exec);
  });
});

describe('elysiaRateLimit', () => {
  const buildCtx = () => ({
    request: ipReq(),
    set: { headers: {} as Record<string, string>, status: undefined as number | undefined },
    store: {} as { rateLimit?: unknown } & Record<string, unknown>,
  });

  it('should return undefined and stamp rateLimit when allowed', async () => {
    const handler = elysiaRateLimit(make(2));
    const ctx = buildCtx();
    const r = await handler(ctx);
    expect(r).toBeUndefined();
    expect(ctx.store.rateLimit).toBeDefined();
    expect(ctx.set.headers['ratelimit']).toBeTruthy();
  });

  it('should return a 429 Response when blocked', async () => {
    const limiter = make(1);
    const handler = elysiaRateLimit(limiter);
    await handler(buildCtx());
    const r = await handler(buildCtx());
    expect(r).toBeInstanceOf(Response);
    expect((r as Response).status).toBe(429);
  });

  it('should set status 429 on the elysia set object when blocked', async () => {
    const limiter = make(1);
    const handler = elysiaRateLimit(limiter);
    await handler(buildCtx());
    const ctx = buildCtx();
    await handler(ctx);
    expect(ctx.set.status).toBe(429);
  });
});

describe('expressRateLimit', () => {
  const buildRes = () => {
    const headers: Record<string, string> = {};
    return {
      statusCode: 200,
      headers,
      setHeader(name: string, value: string) {
        headers[name.toLowerCase()] = value;
      },
      end: vi.fn(),
    };
  };

  it('should call next when allowed', async () => {
    const middleware = expressRateLimit(make(2));
    const next = vi.fn();
    const res = buildRes();
    await middleware(
      { method: 'GET', url: '/x', headers: { 'x-real-ip': '1.1.1.1' } },
      res,
      next,
    );
    expect(next).toHaveBeenCalledWith();
  });

  it('should set rate-limit headers on res', async () => {
    const middleware = expressRateLimit(make(5));
    const res = buildRes();
    await middleware(
      { method: 'GET', url: '/x', headers: { 'x-real-ip': '1.1.1.1' } },
      res,
      vi.fn(),
    );
    expect(res.headers['ratelimit']).toBeTruthy();
  });

  it('should respond with 429 when blocked', async () => {
    const middleware = expressRateLimit(make(1));
    const res = buildRes();
    const next = vi.fn();
    await middleware(
      { method: 'GET', url: '/x', headers: { 'x-real-ip': '1.1.1.1' } },
      res,
      next,
    );
    await middleware(
      { method: 'GET', url: '/x', headers: { 'x-real-ip': '1.1.1.1' } },
      res,
      next,
    );
    expect(res.statusCode).toBe(429);
    expect(res.end).toHaveBeenCalledWith('Too Many Requests');
  });

  it('should call next(err) on a thrown error', async () => {
    const middleware = expressRateLimit({
      check: () => Promise.reject(new Error('crash')),
      peek: () => Promise.reject(new Error('crash')),
      reset: () => Promise.resolve(false),
      resetKey: () => Promise.resolve(false),
      middleware: () => async () => undefined,
      withExecutionCtx: () => ({}) as never,
      config: {} as never,
    });
    const next = vi.fn();
    await middleware(
      { method: 'GET', url: '/x', headers: { 'x-real-ip': '1.1.1.1' } },
      buildRes(),
      next,
    );
    expect(next).toHaveBeenCalledWith(expect.any(Error));
  });

  it('should handle headers presented as arrays', async () => {
    const middleware = expressRateLimit(make(5));
    const res = buildRes();
    await middleware(
      {
        method: 'GET',
        url: '/x',
        headers: { 'x-forwarded-for': ['1.1.1.1, 2.2.2.2'] },
      },
      res,
      vi.fn(),
    );
    expect(res.statusCode).toBe(200);
  });

  it('should skip undefined header values', async () => {
    const middleware = expressRateLimit(make(5));
    const res = buildRes();
    await middleware(
      {
        method: 'GET',
        url: '/x',
        headers: { 'x-real-ip': '1.1.1.1', 'x-undef': undefined },
      },
      res,
      vi.fn(),
    );
    expect(res.statusCode).toBe(200);
  });
});

describe('fastifyRateLimit', () => {
  const buildReply = () => {
    const headers: Record<string, string> = {};
    let status = 200;
    const body: { value?: string } = {};
    const reply = {
      headers,
      status,
      body,
      code(s: number) {
        status = s;
        reply.status = s;
        return reply;
      },
      header(n: string, v: string) {
        headers[n.toLowerCase()] = v;
        return reply;
      },
      async send(b?: string) {
        body.value = b;
      },
    };
    return reply;
  };

  it('should let allowed requests pass with headers stamped', async () => {
    const handler = fastifyRateLimit(make(5));
    const reply = buildReply();
    await handler(
      { method: 'GET', url: '/x', headers: { 'x-real-ip': '1.1.1.1' } },
      reply,
    );
    expect(reply.headers['ratelimit']).toBeTruthy();
    expect(reply.status).toBe(200);
  });

  it('should respond with 429 when blocked', async () => {
    const handler = fastifyRateLimit(make(1));
    const reply = buildReply();
    await handler(
      { method: 'GET', url: '/x', headers: { 'x-real-ip': '1.1.1.1' } },
      reply,
    );
    await handler(
      { method: 'GET', url: '/x', headers: { 'x-real-ip': '1.1.1.1' } },
      reply,
    );
    expect(reply.status).toBe(429);
    expect(reply.body.value).toBe('Too Many Requests');
  });

  it('should accept array headers', async () => {
    const handler = fastifyRateLimit(make(5));
    const reply = buildReply();
    await handler(
      { method: 'GET', url: '/x', headers: { 'x-forwarded-for': ['1.1.1.1'] } },
      reply,
    );
    expect(reply.status).toBe(200);
  });
});

describe('next.js withRateLimit', () => {
  it('should run handler when allowed and merge headers into the response', async () => {
    const handler = vi.fn().mockResolvedValue(new Response('ok'));
    const wrapped = withRateLimit(make(5), handler);
    const res = await wrapped(ipReq());
    expect(handler).toHaveBeenCalled();
    expect(await res.text()).toBe('ok');
    expect(res.headers.get('RateLimit')).toBeTruthy();
  });

  it('should short-circuit with 429 when blocked', async () => {
    const limiter = make(1);
    const handler = vi.fn().mockResolvedValue(new Response('ok'));
    const wrapped = withRateLimit(limiter, handler);
    await wrapped(ipReq());
    const blocked = await wrapped(ipReq());
    expect(blocked.status).toBe(429);
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

describe('next.js rateLimitMiddleware', () => {
  it('should resolve to undefined when allowed', async () => {
    const m = rateLimitMiddleware(make(5));
    expect(await m(ipReq())).toBeUndefined();
  });

  it('should resolve to a 429 Response when blocked', async () => {
    const limiter = make(1);
    const m = rateLimitMiddleware(limiter);
    await m(ipReq());
    const blocked = await m(ipReq());
    expect(blocked).toBeInstanceOf(Response);
    expect(blocked!.status).toBe(429);
  });

  it('should skip requests that fail the matcher', async () => {
    const m = rateLimitMiddleware(make(1), (req) => req.url.includes('/api'));
    expect(await m(new Request('https://example.com/static'))).toBeUndefined();
  });
});

describe('sveltekit rateLimitHandle', () => {
  const buildEvent = (platform?: { context?: { waitUntil(p: Promise<unknown>): void } }) => {
    const event = {
      request: ipReq(),
      locals: {} as Record<string, unknown>,
      platform: platform as undefined,
    };
    return event;
  };

  it('should resolve normally when allowed and stamp result onto locals', async () => {
    const handle = rateLimitHandle(make(2));
    const event = buildEvent();
    const resolve = vi.fn().mockResolvedValue(new Response('ok'));
    const r = await handle({ event, resolve });
    expect(await r.text()).toBe('ok');
    expect(event.locals['rateLimit']).toBeDefined();
    expect(r.headers.get('RateLimit')).toBeTruthy();
  });

  it('should short-circuit with 429 when blocked', async () => {
    const limiter = make(1);
    const handle = rateLimitHandle(limiter);
    const event = buildEvent();
    const resolve = vi.fn().mockResolvedValue(new Response('ok'));
    await handle({ event, resolve });
    const r = await handle({ event: buildEvent(), resolve });
    expect(r.status).toBe(429);
  });

  it('should rebind via withExecutionCtx when platform.context is present', async () => {
    const inner = make(2);
    let captured: unknown = null;
    const wrapped = {
      ...inner,
      withExecutionCtx(ctx: { waitUntil(p: Promise<unknown>): void }) {
        captured = ctx;
        return inner.withExecutionCtx(ctx);
      },
    };
    const handle = rateLimitHandle(wrapped);
    const ctx = { waitUntil: () => undefined };
    await handle({
      event: buildEvent({ context: ctx }),
      resolve: vi.fn().mockResolvedValue(new Response('ok')),
    });
    expect(captured).toBe(ctx);
  });
});
