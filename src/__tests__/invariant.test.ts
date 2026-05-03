import { describe, expect, it } from 'vitest';
import { invariant } from '../core/invariant.js';
import { RateLimitError } from '../errors/base.js';

describe('invariant', () => {
  it('should not throw when condition is truthy', () => {
    expect(() => invariant(true, 'INVALID_CONFIG', 'msg')).not.toThrow();
    expect(() => invariant(1, 'INVALID_CONFIG', 'msg')).not.toThrow();
    expect(() => invariant('x', 'INVALID_CONFIG', 'msg')).not.toThrow();
    expect(() => invariant({}, 'INVALID_CONFIG', 'msg')).not.toThrow();
  });

  it('should throw RateLimitError with given code when condition is falsy', () => {
    try {
      invariant(false, 'INVALID_KEY', 'broken');
      expect.unreachable('expected throw');
    } catch (err) {
      expect(RateLimitError.is(err)).toBe(true);
      expect((err as RateLimitError).code).toBe('INVALID_KEY');
      expect((err as RateLimitError).message).toBe('broken');
    }
  });

  it('should throw on null and undefined', () => {
    expect(() => invariant(null, 'INVALID_CONFIG', 'm')).toThrow(RateLimitError);
    expect(() => invariant(undefined, 'INVALID_CONFIG', 'm')).toThrow(RateLimitError);
  });

  it('should throw on 0 and empty string', () => {
    expect(() => invariant(0, 'INVALID_CONFIG', 'm')).toThrow(RateLimitError);
    expect(() => invariant('', 'INVALID_CONFIG', 'm')).toThrow(RateLimitError);
  });
});
