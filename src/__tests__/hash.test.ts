import { describe, expect, it } from 'vitest';
import { djb2, fnv1a64 } from '../utils/hash.js';

describe('fnv1a64', () => {
  it('should return a 16-char lowercase hex string', () => {
    const h = fnv1a64('hello');
    expect(h).toMatch(/^[0-9a-f]{16}$/);
  });

  it('should be deterministic', () => {
    expect(fnv1a64('hello')).toBe(fnv1a64('hello'));
  });

  it('should produce different output for different input', () => {
    expect(fnv1a64('hello')).not.toBe(fnv1a64('hello!'));
    expect(fnv1a64('a')).not.toBe(fnv1a64('b'));
  });

  it('should produce a stable hash for the empty string', () => {
    expect(fnv1a64('')).toMatch(/^[0-9a-f]{16}$/);
  });

  it('should produce a known reference value for "hello"', () => {
    expect(fnv1a64('hello')).toBe('a430d84680aabd0b');
  });

  it('should handle multi-byte characters by their UTF-16 code unit', () => {
    expect(fnv1a64('é')).toMatch(/^[0-9a-f]{16}$/);
    expect(fnv1a64('é')).not.toBe(fnv1a64('e'));
  });
});

describe('djb2', () => {
  it('should return an 8-char lowercase hex string', () => {
    const h = djb2('hello');
    expect(h).toMatch(/^[0-9a-f]{8}$/);
  });

  it('should be deterministic', () => {
    expect(djb2('hello')).toBe(djb2('hello'));
  });

  it('should produce different output for different input', () => {
    expect(djb2('foo')).not.toBe(djb2('bar'));
  });

  it('should handle empty string', () => {
    expect(djb2('')).toMatch(/^[0-9a-f]{8}$/);
  });
});
