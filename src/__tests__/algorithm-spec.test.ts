import { describe, expect, it } from 'vitest';
import {
  type FlatAlgorithm,
  normaliseFlatAlgorithm,
} from '../core/algorithm-spec.js';
import { RateLimitError } from '../errors/base.js';

describe('normaliseFlatAlgorithm', () => {
  it('should normalise sliding-window into a sliding-window-counter spec', () => {
    const spec = normaliseFlatAlgorithm({
      algorithm: 'sliding-window',
      limit: 100,
      window: '1m',
    });
    expect(spec.kind).toBe('sliding-window-counter');
  });

  it('should normalise sliding-window-log', () => {
    const spec = normaliseFlatAlgorithm({
      algorithm: 'sliding-window-log',
      limit: 10,
      window: '1m',
    });
    expect(spec.kind).toBe('sliding-window-log');
  });

  it('should normalise fixed-window', () => {
    const spec = normaliseFlatAlgorithm({
      algorithm: 'fixed-window',
      limit: 10,
      window: '1m',
    });
    expect(spec.kind).toBe('fixed-window');
  });

  it('should normalise token-bucket with capacity, refill and interval', () => {
    const spec = normaliseFlatAlgorithm({
      algorithm: 'token-bucket',
      capacity: 50,
      refill: 5,
      interval: '1s',
    });
    expect(spec.kind).toBe('token-bucket');
    if (spec.kind === 'token-bucket') {
      expect(spec.capacity).toBe(50);
      expect(spec.refill).toBe(5);
      expect(spec.intervalMs).toBe(1000);
    }
  });

  it('should normalise leaky-bucket with capacity, leak and interval', () => {
    const spec = normaliseFlatAlgorithm({
      algorithm: 'leaky-bucket',
      capacity: 100,
      leak: 10,
      interval: '1s',
    });
    expect(spec.kind).toBe('leaky-bucket');
    if (spec.kind === 'leaky-bucket') {
      expect(spec.capacity).toBe(100);
      expect(spec.leak).toBe(10);
    }
  });

  it('should throw INVALID_CONFIG when limit is non-positive', () => {
    expect(() =>
      normaliseFlatAlgorithm({
        algorithm: 'sliding-window',
        limit: 0,
        window: '1m',
      }),
    ).toThrow(RateLimitError);
  });

  it('should throw INVALID_CONFIG when limit is non-integer', () => {
    expect(() =>
      normaliseFlatAlgorithm({
        algorithm: 'fixed-window',
        limit: 1.5,
        window: '1m',
      }),
    ).toThrow(RateLimitError);
  });

  it('should throw INVALID_CONFIG when refill is non-positive', () => {
    expect(() =>
      normaliseFlatAlgorithm({
        algorithm: 'token-bucket',
        capacity: 10,
        refill: 0,
        interval: '1s',
      }),
    ).toThrow(RateLimitError);
  });

  it('should throw INVALID_CONFIG when leak is non-finite', () => {
    expect(() =>
      normaliseFlatAlgorithm({
        algorithm: 'leaky-bucket',
        capacity: 10,
        leak: Number.NaN,
        interval: '1s',
      }),
    ).toThrow(RateLimitError);
  });

  it('should throw INVALID_CONFIG on unknown algorithm', () => {
    expect(() =>
      normaliseFlatAlgorithm({
        algorithm: 'nope',
        limit: 1,
        window: '1m',
      } as unknown as FlatAlgorithm),
    ).toThrow(RateLimitError);
  });
});
