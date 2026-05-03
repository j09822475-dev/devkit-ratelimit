import { describe, expect, it } from 'vitest';
import { createMemoryStore } from '../adapters/memory/index.js';
import { fixedWindow } from '../algorithms/fixed-window/index.js';
import { leakyBucket } from '../algorithms/leaky-bucket/index.js';
import { slidingWindow } from '../algorithms/sliding-window/index.js';
import { slidingWindowLog } from '../algorithms/sliding-window-log/index.js';
import { tokenBucket } from '../algorithms/token-bucket/index.js';
import { brand, type AlgorithmSpec } from '../types/algorithm.js';

describe('createMemoryStore — name and basic shape', () => {
  it('should expose name "memory"', () => {
    const store = createMemoryStore({ sweepIntervalMs: 0 });
    expect(store.name).toBe('memory');
  });

  it('should accept maxSize option without exploding', () => {
    expect(() => createMemoryStore({ maxSize: 1 })).not.toThrow();
  });

  it('should accept sweepIntervalMs option without exploding', () => {
    expect(() => createMemoryStore({ sweepIntervalMs: 50 })).not.toThrow();
  });
});

describe('createMemoryStore — fixed-window', () => {
  const spec = fixedWindow({ limit: 3, window: '1m' });

  it('should allow up to limit consumes within a window', async () => {
    const store = createMemoryStore({ sweepIntervalMs: 0 });
    const r1 = await store.consume('k1', spec, 1, 0);
    expect(r1.allowed).toBe(true);
    expect(r1.remaining).toBe(2);
    const r2 = await store.consume('k1', spec, 1, 100);
    expect(r2.allowed).toBe(true);
    expect(r2.remaining).toBe(1);
    const r3 = await store.consume('k1', spec, 1, 200);
    expect(r3.allowed).toBe(true);
    expect(r3.remaining).toBe(0);
  });

  it('should block when count exceeds limit', async () => {
    const store = createMemoryStore({ sweepIntervalMs: 0 });
    await store.consume('k', spec, 3, 0);
    const r = await store.consume('k', spec, 1, 100);
    expect(r.allowed).toBe(false);
    expect(r.remaining).toBe(0);
    expect(r.retryAfter).toBeGreaterThan(0);
  });

  it('should reset counter at window boundary', async () => {
    const store = createMemoryStore({ sweepIntervalMs: 0 });
    await store.consume('k', spec, 3, 0);
    const r = await store.consume('k', spec, 1, 60_000);
    expect(r.allowed).toBe(true);
  });

  it('should support cost > 1', async () => {
    const store = createMemoryStore({ sweepIntervalMs: 0 });
    const r = await store.consume('k', spec, 2, 0);
    expect(r.allowed).toBe(true);
    expect(r.remaining).toBe(1);
  });

  it('should reflect blocked state on peek without consuming', async () => {
    const store = createMemoryStore({ sweepIntervalMs: 0 });
    await store.consume('k', spec, 3, 0);
    const p = await store.peek('k', spec, 100);
    expect(p.remaining).toBe(0);
    expect(p.retryAfter).toBeGreaterThan(0);
  });
});

describe('createMemoryStore — sliding-window-counter', () => {
  const spec = slidingWindow({ limit: 10, window: '1m' });

  it('should allow consumes when under limit', async () => {
    const store = createMemoryStore({ sweepIntervalMs: 0 });
    const r = await store.consume('k', spec, 5, 0);
    expect(r.allowed).toBe(true);
    expect(r.remaining).toBe(5);
  });

  it('should approximate count using previous window contribution', async () => {
    const store = createMemoryStore({ sweepIntervalMs: 0 });
    // Fill the first window fully.
    await store.consume('k', spec, 10, 0);
    // Just past the boundary: previous-window contribution dominates.
    const r = await store.consume('k', spec, 1, 60_000);
    // approx ~= floor(10 * (1 - 0)) = 10, so blocked.
    expect(r.allowed).toBe(false);
  });

  it('should allow once enough of the previous window has decayed', async () => {
    const store = createMemoryStore({ sweepIntervalMs: 0 });
    await store.consume('k', spec, 10, 0);
    const r = await store.consume('k', spec, 1, 60_000 + 60_000); // two windows later
    expect(r.allowed).toBe(true);
  });

  it('should report peek remaining without consuming', async () => {
    const store = createMemoryStore({ sweepIntervalMs: 0 });
    await store.consume('k', spec, 3, 0);
    const p = await store.peek('k', spec, 100);
    expect(p.remaining).toBe(7);
  });

  it('should report blocked peek state', async () => {
    const store = createMemoryStore({ sweepIntervalMs: 0 });
    await store.consume('k', spec, 10, 0);
    const p = await store.peek('k', spec, 100);
    expect(p.remaining).toBe(0);
    expect(p.retryAfter).toBeGreaterThan(0);
  });
});

describe('createMemoryStore — sliding-window-log', () => {
  const spec = slidingWindowLog({ limit: 3, window: '1m' });

  it('should track exact timestamps and admit up to limit', async () => {
    const store = createMemoryStore({ sweepIntervalMs: 0 });
    const r1 = await store.consume('k', spec, 1, 0);
    expect(r1.allowed).toBe(true);
    const r2 = await store.consume('k', spec, 1, 1000);
    expect(r2.allowed).toBe(true);
    const r3 = await store.consume('k', spec, 1, 2000);
    expect(r3.allowed).toBe(true);
    const r4 = await store.consume('k', spec, 1, 3000);
    expect(r4.allowed).toBe(false);
  });

  it('should drop expired timestamps after window passes', async () => {
    const store = createMemoryStore({ sweepIntervalMs: 0 });
    await store.consume('k', spec, 3, 0);
    const r = await store.consume('k', spec, 1, 60_001);
    expect(r.allowed).toBe(true);
  });

  it('should reflect remaining via peek without consuming', async () => {
    const store = createMemoryStore({ sweepIntervalMs: 0 });
    await store.consume('k', spec, 2, 100);
    const p = await store.peek('k', spec, 200);
    expect(p.remaining).toBe(1);
  });

  it('should support cost > 1 by appending multiple timestamps', async () => {
    const store = createMemoryStore({ sweepIntervalMs: 0 });
    const r = await store.consume('k', spec, 3, 0);
    expect(r.allowed).toBe(true);
    expect(r.remaining).toBe(0);
  });
});

describe('createMemoryStore — token-bucket', () => {
  const spec = tokenBucket({ capacity: 5, refill: 5, interval: '1s' });

  it('should start full and allow a burst up to capacity', async () => {
    const store = createMemoryStore({ sweepIntervalMs: 0 });
    const r = await store.consume('k', spec, 5, 0);
    expect(r.allowed).toBe(true);
    expect(r.remaining).toBe(0);
  });

  it('should block when the bucket is empty', async () => {
    const store = createMemoryStore({ sweepIntervalMs: 0 });
    await store.consume('k', spec, 5, 0);
    const r = await store.consume('k', spec, 1, 100);
    expect(r.allowed).toBe(false);
    expect(r.retryAfter).toBeGreaterThan(0);
  });

  it('should refill over time', async () => {
    const store = createMemoryStore({ sweepIntervalMs: 0 });
    await store.consume('k', spec, 5, 0);
    const r = await store.consume('k', spec, 5, 1000); // full second elapsed → +5
    expect(r.allowed).toBe(true);
  });

  it('should clamp settled level at capacity', async () => {
    const store = createMemoryStore({ sweepIntervalMs: 0 });
    await store.consume('k', spec, 5, 0); // empty
    // Wait far longer than a full interval — should not exceed capacity.
    const p = await store.peek('k', spec, 60_000);
    expect(p.remaining).toBe(5);
  });

  it('should report retryAfter on peek when bucket empty', async () => {
    const store = createMemoryStore({ sweepIntervalMs: 0 });
    await store.consume('k', spec, 5, 0);
    const p = await store.peek('k', spec, 0);
    expect(p.remaining).toBe(0);
    expect(p.retryAfter).toBeGreaterThan(0);
  });

  it('should absorb backwards clock jumps without going negative', async () => {
    const store = createMemoryStore({ sweepIntervalMs: 0 });
    await store.consume('k', spec, 1, 1000);
    // now < updatedAt
    const r = await store.consume('k', spec, 1, 500);
    expect(r.allowed).toBe(true);
  });
});

describe('createMemoryStore — leaky-bucket', () => {
  const spec = leakyBucket({ capacity: 5, leak: 5, interval: '1s' });

  it('should accept up to capacity initially', async () => {
    const store = createMemoryStore({ sweepIntervalMs: 0 });
    const r = await store.consume('k', spec, 5, 0);
    expect(r.allowed).toBe(true);
    expect(r.remaining).toBe(0);
  });

  it('should overflow when adding beyond capacity', async () => {
    const store = createMemoryStore({ sweepIntervalMs: 0 });
    await store.consume('k', spec, 5, 0);
    const r = await store.consume('k', spec, 1, 100);
    expect(r.allowed).toBe(false);
    expect(r.retryAfter).toBeGreaterThan(0);
  });

  it('should drain over time', async () => {
    const store = createMemoryStore({ sweepIntervalMs: 0 });
    await store.consume('k', spec, 5, 0);
    const r = await store.consume('k', spec, 5, 1000); // drain 5 over 1 second
    expect(r.allowed).toBe(true);
  });

  it('should expose remaining capacity via peek', async () => {
    const store = createMemoryStore({ sweepIntervalMs: 0 });
    await store.consume('k', spec, 2, 0);
    const p = await store.peek('k', spec, 0);
    expect(p.remaining).toBe(3);
  });
});

describe('createMemoryStore — reset', () => {
  it('should return false for a missing key', async () => {
    const store = createMemoryStore({ sweepIntervalMs: 0 });
    expect(await store.reset('missing')).toBe(false);
  });

  it('should drop existing state and return true', async () => {
    const store = createMemoryStore({ sweepIntervalMs: 0 });
    const spec = fixedWindow({ limit: 3, window: '1m' });
    await store.consume('k', spec, 3, 0);
    expect(await store.reset('k')).toBe(true);
    const r = await store.consume('k', spec, 1, 100);
    expect(r.allowed).toBe(true);
    expect(r.remaining).toBe(2);
  });
});

describe('createMemoryStore — sweep', () => {
  it('should remove sliding-window-log entries that have been emptied by trim+block', async () => {
    const store = createMemoryStore({ sweepIntervalMs: 0 });
    const spec = slidingWindowLog({ limit: 3, window: '1m' });
    await store.consume('k', spec, 3, 0);
    // After window passes, a blocked consume (cost > limit) trims to []
    // and writes back an empty-timestamps entry — exactly the shape
    // sweep is designed to drop.
    const blocked = await store.consume('k', spec, 4, 60_001);
    expect(blocked.allowed).toBe(false);
    const dropped = (await store.sweep?.(60_001)) ?? 0;
    expect(dropped).toBe(1);
  });

  it('should default to Date.now() when no override is given', async () => {
    const store = createMemoryStore({ sweepIntervalMs: 0 });
    expect(typeof (await store.sweep?.())).toBe('number');
  });

  it('should leave non-expirable entries intact', async () => {
    const store = createMemoryStore({ sweepIntervalMs: 0 });
    const spec = tokenBucket({ capacity: 5, refill: 5, interval: '1s' });
    await store.consume('k', spec, 1, 0);
    const dropped = (await store.sweep?.(10 * 86_400_000)) ?? 0;
    expect(dropped).toBe(0);
  });
});

describe('createMemoryStore — peek does not promote MRU', () => {
  it('should not keep an idle key alive at the expense of active keys', async () => {
    const store = createMemoryStore({ maxSize: 2, sweepIntervalMs: 0 });
    const spec = fixedWindow({ limit: 5, window: '1m' });
    // Insert two entries.
    await store.consume('a', spec, 1, 0);
    await store.consume('b', spec, 1, 0);
    // Polling 'a' via peek must NOT promote it to MRU.
    await store.peek('a', spec, 0);
    // Inserting 'c' should evict whichever entry was *not* most recently
    // mutated — that's 'a' because 'b' was the most recent consume.
    await store.consume('c', spec, 1, 0);
    // Re-consuming 'a' should look like a fresh entry (count = 1).
    const r = await store.consume('a', spec, 1, 100);
    expect(r.remaining).toBe(4);
  });
});

describe('createMemoryStore — unknown algorithm kind', () => {
  it('should throw INVALID_CONFIG on unknown spec.kind', async () => {
    const store = createMemoryStore({ sweepIntervalMs: 0 });
    const bogus = brand({ kind: 'bogus' as never }) as unknown as AlgorithmSpec;
    await expect(store.consume('k', bogus, 1, 0)).rejects.toThrow(/unknown algorithm kind/);
  });
});
