import { describe, expect, it } from 'vitest';
import { fixedWindow } from '../algorithms/fixed-window/index.js';
import { leakyBucket } from '../algorithms/leaky-bucket/index.js';
import { slidingWindow } from '../algorithms/sliding-window/index.js';
import { slidingWindowLog } from '../algorithms/sliding-window-log/index.js';
import { tokenBucket } from '../algorithms/token-bucket/index.js';
import { RateLimitError } from '../errors/base.js';

describe('slidingWindow', () => {
  it('should brand a sliding-window-counter spec when given valid input', () => {
    const spec = slidingWindow({ limit: 100, window: '1m' });
    expect(spec.kind).toBe('sliding-window-counter');
    expect(spec.limit).toBe(100);
    expect(spec.windowMs).toBe(60_000);
  });

  it('should accept numeric window', () => {
    const spec = slidingWindow({ limit: 1, window: 1000 });
    expect(spec.windowMs).toBe(1000);
  });

  it('should throw INVALID_CONFIG on non-positive limit', () => {
    expect(() => slidingWindow({ limit: 0, window: '1m' })).toThrow(RateLimitError);
    expect(() => slidingWindow({ limit: -1, window: '1m' })).toThrow(RateLimitError);
  });

  it('should throw INVALID_CONFIG on fractional limit', () => {
    expect(() => slidingWindow({ limit: 1.5, window: '1m' })).toThrow(RateLimitError);
  });

  it('should throw INVALID_CONFIG on non-finite limit', () => {
    expect(() => slidingWindow({ limit: Number.NaN, window: '1m' })).toThrow(RateLimitError);
    expect(() => slidingWindow({ limit: Number.POSITIVE_INFINITY, window: '1m' })).toThrow(
      RateLimitError,
    );
  });

  it('should throw INVALID_CONFIG on non-number limit', () => {
    expect(() => slidingWindow({ limit: '10' as unknown as number, window: '1m' })).toThrow(
      RateLimitError,
    );
  });
});

describe('slidingWindowLog', () => {
  it('should brand a sliding-window-log spec when given valid input', () => {
    const spec = slidingWindowLog({ limit: 50, window: '1h' });
    expect(spec.kind).toBe('sliding-window-log');
    expect(spec.limit).toBe(50);
    expect(spec.windowMs).toBe(3_600_000);
  });

  it('should throw INVALID_CONFIG on non-positive limit', () => {
    expect(() => slidingWindowLog({ limit: 0, window: '1m' })).toThrow(RateLimitError);
  });

  it('should throw INVALID_CONFIG on fractional limit', () => {
    expect(() => slidingWindowLog({ limit: 1.5, window: '1m' })).toThrow(RateLimitError);
  });

  it('should throw INVALID_CONFIG on non-finite limit', () => {
    expect(() => slidingWindowLog({ limit: Number.NaN, window: '1m' })).toThrow(RateLimitError);
  });
});

describe('fixedWindow', () => {
  it('should brand a fixed-window spec when given valid input', () => {
    const spec = fixedWindow({ limit: 60, window: '1m' });
    expect(spec.kind).toBe('fixed-window');
    expect(spec.limit).toBe(60);
    expect(spec.windowMs).toBe(60_000);
  });

  it('should throw INVALID_CONFIG on non-positive limit', () => {
    expect(() => fixedWindow({ limit: 0, window: '1m' })).toThrow(RateLimitError);
  });

  it('should throw INVALID_CONFIG on fractional limit', () => {
    expect(() => fixedWindow({ limit: 1.5, window: '1m' })).toThrow(RateLimitError);
  });

  it('should throw INVALID_CONFIG on non-finite limit', () => {
    expect(() => fixedWindow({ limit: Number.NaN, window: '1m' })).toThrow(RateLimitError);
  });
});

describe('tokenBucket', () => {
  it('should brand a token-bucket spec when given valid input', () => {
    const spec = tokenBucket({ capacity: 50, refill: 5, interval: '1s' });
    expect(spec.kind).toBe('token-bucket');
    expect(spec.capacity).toBe(50);
    expect(spec.refill).toBe(5);
    expect(spec.intervalMs).toBe(1000);
  });

  it('should accept fractional refill', () => {
    const spec = tokenBucket({ capacity: 50, refill: 0.5, interval: '1s' });
    expect(spec.refill).toBe(0.5);
  });

  it('should throw INVALID_CONFIG on non-positive capacity', () => {
    expect(() => tokenBucket({ capacity: 0, refill: 1, interval: '1s' })).toThrow(RateLimitError);
  });

  it('should throw INVALID_CONFIG on fractional capacity', () => {
    expect(() =>
      tokenBucket({ capacity: 1.5, refill: 1, interval: '1s' }),
    ).toThrow(RateLimitError);
  });

  it('should throw INVALID_CONFIG on non-positive refill', () => {
    expect(() => tokenBucket({ capacity: 1, refill: 0, interval: '1s' })).toThrow(RateLimitError);
    expect(() => tokenBucket({ capacity: 1, refill: -1, interval: '1s' })).toThrow(RateLimitError);
  });

  it('should throw INVALID_CONFIG on non-finite refill', () => {
    expect(() =>
      tokenBucket({ capacity: 1, refill: Number.NaN, interval: '1s' }),
    ).toThrow(RateLimitError);
  });

  it('should throw INVALID_CONFIG on non-number capacity', () => {
    expect(() =>
      tokenBucket({ capacity: '5' as unknown as number, refill: 1, interval: '1s' }),
    ).toThrow(RateLimitError);
  });
});

describe('leakyBucket', () => {
  it('should brand a leaky-bucket spec when given valid input', () => {
    const spec = leakyBucket({ capacity: 100, leak: 10, interval: '1s' });
    expect(spec.kind).toBe('leaky-bucket');
    expect(spec.capacity).toBe(100);
    expect(spec.leak).toBe(10);
    expect(spec.intervalMs).toBe(1000);
  });

  it('should throw INVALID_CONFIG on non-positive capacity', () => {
    expect(() => leakyBucket({ capacity: 0, leak: 1, interval: '1s' })).toThrow(RateLimitError);
  });

  it('should throw INVALID_CONFIG on fractional capacity', () => {
    expect(() =>
      leakyBucket({ capacity: 1.5, leak: 1, interval: '1s' }),
    ).toThrow(RateLimitError);
  });

  it('should throw INVALID_CONFIG when leak is zero (non-leaking bucket)', () => {
    expect(() => leakyBucket({ capacity: 1, leak: 0, interval: '1s' })).toThrow(RateLimitError);
  });

  it('should throw INVALID_CONFIG when leak is negative', () => {
    expect(() => leakyBucket({ capacity: 1, leak: -1, interval: '1s' })).toThrow(RateLimitError);
  });

  it('should throw INVALID_CONFIG when leak is non-finite', () => {
    expect(() =>
      leakyBucket({ capacity: 1, leak: Number.POSITIVE_INFINITY, interval: '1s' }),
    ).toThrow(RateLimitError);
  });
});
