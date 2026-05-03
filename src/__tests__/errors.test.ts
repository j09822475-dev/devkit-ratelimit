import { describe, expect, expectTypeOf, it } from 'vitest';
import { RateLimitError } from '../errors/base.js';
import { RATELIMIT_ERROR_CODES, type RateLimitErrorCode } from '../errors/codes.js';

describe('RateLimitError', () => {
  it('should expose code, message and publicMessage when constructed', () => {
    const err = new RateLimitError('INVALID_CONFIG', 'bad config');
    expect(err.code).toBe('INVALID_CONFIG');
    expect(err.message).toBe('bad config');
    expect(err.publicMessage).toBe('bad config');
    expect(err.name).toBe('RateLimitError');
  });

  it('should preserve cause when supplied', () => {
    const cause = new Error('underlying');
    const err = new RateLimitError('STORE_UNAVAILABLE', 'wrapped', cause);
    expect(err.cause).toBe(cause);
  });

  it('should omit cause property when cause is undefined', () => {
    const err = new RateLimitError('INVALID_CONFIG', 'no cause');
    expect(err.cause).toBeUndefined();
  });

  it('should preserve a non-Error cause when supplied', () => {
    const err = new RateLimitError('STORE_UNAVAILABLE', 'wrapped', 'string cause');
    expect(err.cause).toBe('string cause');
  });

  it('should be instanceof Error', () => {
    const err = new RateLimitError('INVALID_CONFIG', 'msg');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(RateLimitError);
  });

  describe('RateLimitError.is', () => {
    it('should return true when value is a RateLimitError instance', () => {
      const err = new RateLimitError('INVALID_KEY', 'bad key');
      expect(RateLimitError.is(err)).toBe(true);
    });

    it('should return true when value structurally looks like RateLimitError (cross-realm)', () => {
      const fake = { name: 'RateLimitError', code: 'STORE_UNAVAILABLE' };
      expect(RateLimitError.is(fake)).toBe(true);
    });

    it('should return false for null', () => {
      expect(RateLimitError.is(null)).toBe(false);
    });

    it('should return false for undefined', () => {
      expect(RateLimitError.is(undefined)).toBe(false);
    });

    it('should return false for primitives', () => {
      expect(RateLimitError.is('string')).toBe(false);
      expect(RateLimitError.is(123)).toBe(false);
      expect(RateLimitError.is(true)).toBe(false);
    });

    it('should return false for plain Error', () => {
      expect(RateLimitError.is(new Error('plain'))).toBe(false);
    });

    it('should return false when name matches but code missing', () => {
      expect(RateLimitError.is({ name: 'RateLimitError' })).toBe(false);
    });

    it('should return false when code missing or non-string', () => {
      expect(RateLimitError.is({ name: 'RateLimitError', code: 123 })).toBe(false);
    });
  });

  it('should narrow code type correctly', () => {
    const err = new RateLimitError('INVALID_CONFIG', 'm');
    expectTypeOf(err.code).toEqualTypeOf<RateLimitErrorCode>();
  });
});

describe('RATELIMIT_ERROR_CODES', () => {
  it('should expose every documented stable code', () => {
    expect(RATELIMIT_ERROR_CODES).toEqual([
      'INVALID_CONFIG',
      'INVALID_COST',
      'INVALID_KEY',
      'INVALID_TIER',
      'STORE_UNAVAILABLE',
      'WINDOW_TOO_LARGE',
      'PAYLOAD_TOO_LARGE',
      'KEY_TOO_LONG',
    ]);
  });

  it('should be a readonly tuple', () => {
    expectTypeOf<RateLimitErrorCode>().toEqualTypeOf<
      | 'INVALID_CONFIG'
      | 'INVALID_COST'
      | 'INVALID_KEY'
      | 'INVALID_TIER'
      | 'STORE_UNAVAILABLE'
      | 'WINDOW_TOO_LARGE'
      | 'PAYLOAD_TOO_LARGE'
      | 'KEY_TOO_LONG'
    >();
  });
});
