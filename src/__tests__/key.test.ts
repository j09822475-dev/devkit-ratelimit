import { describe, expect, it } from 'vitest';
import {
  composeKey,
  defaultKeyGenerator,
  defaultKeyGeneratorWith,
} from '../core/key.js';

const makeReq = (headers: Record<string, string>): Request =>
  new Request('https://example.com/', { headers });

describe('composeKey', () => {
  it('should join prefix, scope and userKey with colons by default', () => {
    expect(composeKey('rl', 'sw:1m', '1.2.3.4')).toBe('rl:sw:1m:1.2.3.4');
  });

  it('should return userKey alone when both prefix and scope are empty', () => {
    expect(composeKey('', '', 'k')).toBe('k');
  });

  it('should omit prefix when prefix is empty', () => {
    expect(composeKey('', 'scope', 'k')).toBe('scope:k');
  });

  it('should omit scope when scope is empty', () => {
    expect(composeKey('rl', '', 'k')).toBe('rl:k');
  });
});

describe('defaultKeyGenerator', () => {
  it('should pull from cf-connecting-ip when present', async () => {
    const req = makeReq({ 'cf-connecting-ip': '1.2.3.4' });
    const result = await defaultKeyGenerator(req, {});
    expect(result).toBe('1.2.3.4');
  });

  it('should fall back to x-real-ip when cf-connecting-ip absent', async () => {
    const req = makeReq({ 'x-real-ip': '5.6.7.8' });
    const result = await defaultKeyGenerator(req, {});
    expect(result).toBe('5.6.7.8');
  });

  it('should use first hop of x-forwarded-for as last resort', async () => {
    const req = makeReq({ 'x-forwarded-for': '9.9.9.9, 10.0.0.1' });
    const result = await defaultKeyGenerator(req, {});
    expect(result).toBe('9.9.9.9');
  });

  it('should prefer ctx.connectingIp over header sources', async () => {
    const req = makeReq({ 'cf-connecting-ip': '1.2.3.4' });
    const result = await defaultKeyGenerator(req, { connectingIp: '11.11.11.11' });
    expect(result).toBe('11.11.11.11');
  });

  it('should return null when no IP source available', async () => {
    const req = makeReq({});
    const result = await defaultKeyGenerator(req, {});
    expect(result).toBeNull();
  });

  it('should return null when x-forwarded-for is empty whitespace', async () => {
    const req = makeReq({ 'x-forwarded-for': '   ,  ' });
    const result = await defaultKeyGenerator(req, {});
    expect(result).toBeNull();
  });

  it('should normalise IPv4-mapped IPv6 addresses', async () => {
    const req = makeReq({ 'x-real-ip': '::ffff:1.2.3.4' });
    const result = await defaultKeyGenerator(req, {});
    expect(result).toBe('1.2.3.4');
  });

  it('should trim whitespace from forwarded hop', async () => {
    const req = makeReq({ 'x-forwarded-for': '  1.2.3.4  ,5.6.7.8' });
    const result = await defaultKeyGenerator(req, {});
    expect(result).toBe('1.2.3.4');
  });
});

describe('defaultKeyGeneratorWith({ ipv6Prefix })', () => {
  it('should not collapse IPv6 when no ipv6Prefix configured', async () => {
    const gen = defaultKeyGeneratorWith();
    const req = makeReq({ 'x-real-ip': '2001:db8::1' });
    const result = await gen(req, {});
    expect(result).toBe('2001:db8::1');
  });

  it('should collapse IPv6 to leading prefix bits when ipv6Prefix set', async () => {
    const gen = defaultKeyGeneratorWith({ ipv6Prefix: 64 });
    const req = makeReq({ 'x-real-ip': '2001:0db8:0000:0000:0001:0002:0003:0004' });
    const result = await gen(req, {});
    expect(result).toBe('2001:0db8:0000:0000::/64');
  });

  it('should expand "::" before collapsing', async () => {
    const gen = defaultKeyGeneratorWith({ ipv6Prefix: 32 });
    const req = makeReq({ 'x-real-ip': '2001:db8::1' });
    const result = await gen(req, {});
    expect(result).toBe('2001:db8::/32');
  });

  it('should not collapse IPv4 addresses regardless of ipv6Prefix', async () => {
    const gen = defaultKeyGeneratorWith({ ipv6Prefix: 64 });
    const req = makeReq({ 'x-real-ip': '1.2.3.4' });
    const result = await gen(req, {});
    expect(result).toBe('1.2.3.4');
  });

  it('should clamp ipv6Prefix to a single group at minimum', async () => {
    const gen = defaultKeyGeneratorWith({ ipv6Prefix: 8 });
    const req = makeReq({ 'x-real-ip': '2001:db8::1' });
    const result = await gen(req, {});
    expect(result).toBe('2001::/8');
  });

  it('should handle leading "::" by treating left side as empty', async () => {
    const gen = defaultKeyGeneratorWith({ ipv6Prefix: 32 });
    const req = makeReq({ 'x-real-ip': '::1' });
    const result = await gen(req, {});
    expect(result).toBe('0:0::/32');
  });
});
