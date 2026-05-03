/**
 * Sugar-form algorithm normaliser. Maps a `RateLimitFlatConfig`'s string
 * `algorithm` discriminator + tuning fields onto the corresponding
 * branded {@link AlgorithmSpec}. Lives in `core/` so the sugar overload
 * doesn't have to import every algorithm subpath.
 */

import { RateLimitError } from '../errors/base.js';
import type { AlgorithmSpec } from '../types/algorithm.js';
import { brand } from '../types/algorithm.js';
import { parseDuration } from './duration.js';
import type { Duration } from '../types/runtime.js';

/**
 * Narrow tuning-field shape extracted from a `RateLimitFlatConfig`.
 * Kept internal — callers always go through {@link normaliseFlatAlgorithm}.
 *
 * @internal
 */
export type FlatAlgorithm =
  | { algorithm: 'sliding-window'; limit: number; window: Duration }
  | { algorithm: 'sliding-window-log'; limit: number; window: Duration }
  | { algorithm: 'fixed-window'; limit: number; window: Duration }
  | { algorithm: 'token-bucket'; capacity: number; refill: number; interval: Duration }
  | { algorithm: 'leaky-bucket'; capacity: number; leak: number; interval: Duration };

/**
 * Normalise the flat-form `algorithm` + tuning fields into a branded
 * {@link AlgorithmSpec}.
 *
 * @param flat Flat config (subset).
 * @returns    Branded spec.
 * @throws     `RateLimitError('INVALID_CONFIG')` on bounds violations.
 */
export function normaliseFlatAlgorithm(flat: FlatAlgorithm): AlgorithmSpec {
  switch (flat.algorithm) {
    case 'sliding-window': {
      const limit = flat.limit;
      const window = flat.window;
      assertPositiveInt(limit, 'limit');
      const windowMs = parseDuration(window);
      return brand({ kind: 'sliding-window-counter' as const, limit, windowMs });
    }
    case 'sliding-window-log': {
      const limit = flat.limit;
      const window = flat.window;
      assertPositiveInt(limit, 'limit');
      const windowMs = parseDuration(window);
      return brand({ kind: 'sliding-window-log' as const, limit, windowMs });
    }
    case 'fixed-window': {
      const limit = flat.limit;
      const window = flat.window;
      assertPositiveInt(limit, 'limit');
      const windowMs = parseDuration(window);
      return brand({ kind: 'fixed-window' as const, limit, windowMs });
    }
    case 'token-bucket': {
      const capacity = flat.capacity;
      const refill = flat.refill;
      const interval = flat.interval;
      assertPositiveInt(capacity, 'capacity');
      assertPositiveNumber(refill, 'refill');
      const intervalMs = parseDuration(interval);
      return brand({ kind: 'token-bucket' as const, capacity, refill, intervalMs });
    }
    case 'leaky-bucket': {
      const capacity = flat.capacity;
      const leak = flat.leak;
      const interval = flat.interval;
      assertPositiveInt(capacity, 'capacity');
      assertPositiveNumber(leak, 'leak');
      const intervalMs = parseDuration(interval);
      return brand({ kind: 'leaky-bucket' as const, capacity, leak, intervalMs });
    }
    default: {
      const exhaustive: never = flat;
      throw new RateLimitError(
        'INVALID_CONFIG',
        `unknown algorithm '${(exhaustive as { algorithm: string }).algorithm}'`,
      );
    }
  }
}

function assertPositiveInt(value: unknown, name: string): asserts value is number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value <= 0
  ) {
    throw new RateLimitError(
      'INVALID_CONFIG',
      `${name} must be a positive integer, got ${String(value)}`,
    );
  }
}

function assertPositiveNumber(value: unknown, name: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new RateLimitError(
      'INVALID_CONFIG',
      `${name} must be a positive finite number, got ${String(value)}`,
    );
  }
}
