import { describe, expect, it } from 'vitest';
import { parseDuration } from '../core/duration.js';
import { RateLimitError } from '../errors/base.js';

describe('parseDuration', () => {
  describe('numeric input', () => {
    it('should accept positive integer ms when given a number', () => {
      expect(parseDuration(1)).toBe(1);
      expect(parseDuration(1000)).toBe(1000);
      expect(parseDuration(60_000)).toBe(60_000);
    });

    it('should throw INVALID_CONFIG when number is zero', () => {
      expect(() => parseDuration(0)).toThrow(RateLimitError);
    });

    it('should throw INVALID_CONFIG when number is negative', () => {
      expect(() => parseDuration(-1)).toThrow(RateLimitError);
    });

    it('should throw INVALID_CONFIG when number is fractional', () => {
      try {
        parseDuration(1.5);
        expect.unreachable('expected throw');
      } catch (err) {
        expect(RateLimitError.is(err)).toBe(true);
        expect((err as RateLimitError).code).toBe('INVALID_CONFIG');
      }
    });

    it('should throw INVALID_CONFIG when number is NaN', () => {
      expect(() => parseDuration(Number.NaN)).toThrow(RateLimitError);
    });

    it('should throw INVALID_CONFIG when number is Infinity', () => {
      expect(() => parseDuration(Number.POSITIVE_INFINITY)).toThrow(RateLimitError);
    });
  });

  describe('string input', () => {
    it('should parse "1ms" as 1ms', () => {
      expect(parseDuration('1ms')).toBe(1);
    });

    it('should parse "500 ms" with single space as 500ms', () => {
      expect(parseDuration('500 ms')).toBe(500);
    });

    it('should parse "1s" as 1000ms', () => {
      expect(parseDuration('1s')).toBe(1000);
    });

    it('should parse "1m" as 60000ms', () => {
      expect(parseDuration('1m')).toBe(60_000);
    });

    it('should parse "1h" as 3600000ms', () => {
      expect(parseDuration('1h')).toBe(3_600_000);
    });

    it('should parse "1d" as 86400000ms', () => {
      expect(parseDuration('1d')).toBe(86_400_000);
    });

    it('should throw INVALID_CONFIG on malformed string', () => {
      expect(() => parseDuration('1x' as never)).toThrow(RateLimitError);
    });

    it('should throw INVALID_CONFIG on empty string', () => {
      expect(() => parseDuration('' as never)).toThrow(RateLimitError);
    });

    it('should throw INVALID_CONFIG on negative string', () => {
      expect(() => parseDuration('-1s' as never)).toThrow(RateLimitError);
    });

    it('should throw INVALID_CONFIG on fractional string', () => {
      expect(() => parseDuration('1.5s' as never)).toThrow(RateLimitError);
    });

    it('should throw INVALID_CONFIG when value resolves to zero', () => {
      expect(() => parseDuration('0s' as never)).toThrow(RateLimitError);
    });
  });

  describe('object input', () => {
    it('should parse milliseconds field', () => {
      expect(parseDuration({ milliseconds: 250 })).toBe(250);
    });

    it('should parse seconds field', () => {
      expect(parseDuration({ seconds: 5 })).toBe(5_000);
    });

    it('should parse minutes field', () => {
      expect(parseDuration({ minutes: 1 })).toBe(60_000);
    });

    it('should parse hours field', () => {
      expect(parseDuration({ hours: 1 })).toBe(3_600_000);
    });

    it('should parse days field', () => {
      expect(parseDuration({ days: 1 })).toBe(86_400_000);
    });

    it('should sum multiple fields together', () => {
      expect(parseDuration({ minutes: 1, seconds: 30 })).toBe(90_000);
    });

    it('should truncate fractional ms results to integer', () => {
      expect(parseDuration({ minutes: 1.5 })).toBe(90_000);
      expect(parseDuration({ milliseconds: 1.7 })).toBe(1);
    });

    it('should throw INVALID_CONFIG when object resolves to zero', () => {
      expect(() => parseDuration({})).toThrow(RateLimitError);
    });

    it('should throw INVALID_CONFIG when object resolves to negative', () => {
      expect(() => parseDuration({ seconds: -1 })).toThrow(RateLimitError);
    });
  });

  it('should throw INVALID_CONFIG when given an unsupported type', () => {
    expect(() => parseDuration(true as never)).toThrow(RateLimitError);
    expect(() => parseDuration(null as never)).toThrow(RateLimitError);
  });
});
