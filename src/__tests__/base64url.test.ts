import { describe, expect, it } from 'vitest';
import { base64urlDecode, base64urlEncode } from '../utils/base64url.js';

describe('base64urlEncode', () => {
  it('should encode an ASCII string', () => {
    expect(base64urlEncode('hello')).toBe('aGVsbG8');
  });

  it('should encode the empty string to empty', () => {
    expect(base64urlEncode('')).toBe('');
  });

  it('should not include padding "="', () => {
    expect(base64urlEncode('hi')).not.toMatch(/=/);
  });

  it('should use - and _ instead of + and /', () => {
    const encoded = base64urlEncode('?>>??');
    expect(encoded).not.toMatch(/[+/]/);
  });

  it('should encode multi-byte UTF-8 characters', () => {
    const encoded = base64urlEncode('héllo');
    expect(typeof encoded).toBe('string');
    expect(encoded.length).toBeGreaterThan(0);
  });
});

describe('base64urlDecode', () => {
  it('should decode an encoded ASCII string', () => {
    expect(base64urlDecode('aGVsbG8')).toBe('hello');
  });

  it('should round-trip arbitrary strings', () => {
    const inputs = ['hello', '', 'foo bar', 'spaces and !@#$%^', 'a/b+c=d'];
    for (const s of inputs) {
      expect(base64urlDecode(base64urlEncode(s))).toBe(s);
    }
  });

  it('should round-trip multi-byte UTF-8', () => {
    const inputs = ['héllo', 'café', 'naïve', 'Здравствуй'];
    for (const s of inputs) {
      expect(base64urlDecode(base64urlEncode(s))).toBe(s);
    }
  });

  it('should accept input that already needs no padding', () => {
    expect(base64urlDecode('YQ')).toBe('a');
  });
});
