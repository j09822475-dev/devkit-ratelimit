import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nowMs } from '../core/time.js';

describe('nowMs', () => {
  it('should return Date.now() at call time', () => {
    const before = Date.now();
    const v = nowMs();
    const after = Date.now();
    expect(v).toBeGreaterThanOrEqual(before);
    expect(v).toBeLessThanOrEqual(after);
  });

  it('should track injected fake timers', () => {
    beforeEach(() => undefined);
    afterEach(() => undefined);
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2024-01-01T00:00:00Z'));
      expect(nowMs()).toBe(new Date('2024-01-01T00:00:00Z').getTime());
    } finally {
      vi.useRealTimers();
    }
  });
});
