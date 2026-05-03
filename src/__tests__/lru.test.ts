import { describe, expect, it } from 'vitest';
import { Lru } from '../utils/lru.js';

describe('Lru', () => {
  it('should report size 0 when empty', () => {
    const lru = new Lru<string, number>(3);
    expect(lru.size).toBe(0);
  });

  it('should set and get values', () => {
    const lru = new Lru<string, number>(3);
    lru.set('a', 1);
    expect(lru.get('a')).toBe(1);
    expect(lru.size).toBe(1);
  });

  it('should return undefined for missing keys', () => {
    const lru = new Lru<string, number>(3);
    expect(lru.get('missing')).toBeUndefined();
  });

  it('should report has() correctly', () => {
    const lru = new Lru<string, number>(3);
    lru.set('a', 1);
    expect(lru.has('a')).toBe(true);
    expect(lru.has('b')).toBe(false);
  });

  it('should evict the least-recently-touched entry on overflow', () => {
    const lru = new Lru<string, number>(2);
    lru.set('a', 1);
    lru.set('b', 2);
    lru.set('c', 3);
    expect(lru.has('a')).toBe(false);
    expect(lru.has('b')).toBe(true);
    expect(lru.has('c')).toBe(true);
  });

  it('should promote on get so the most-recently-touched survives eviction', () => {
    const lru = new Lru<string, number>(2);
    lru.set('a', 1);
    lru.set('b', 2);
    lru.get('a');
    lru.set('c', 3);
    expect(lru.has('a')).toBe(true);
    expect(lru.has('b')).toBe(false);
  });

  it('should NOT promote on peek (read-only inspection)', () => {
    const lru = new Lru<string, number>(2);
    lru.set('a', 1);
    lru.set('b', 2);
    lru.peek('a');
    lru.set('c', 3);
    expect(lru.has('a')).toBe(false);
    expect(lru.has('b')).toBe(true);
  });

  it('should return value on peek without changing MRU order', () => {
    const lru = new Lru<string, number>(3);
    lru.set('a', 1);
    expect(lru.peek('a')).toBe(1);
    expect(lru.peek('missing')).toBeUndefined();
  });

  it('should update value when set is called with an existing key', () => {
    const lru = new Lru<string, number>(2);
    lru.set('a', 1);
    lru.set('a', 99);
    expect(lru.get('a')).toBe(99);
    expect(lru.size).toBe(1);
  });

  it('should refresh MRU when set is called with an existing key', () => {
    const lru = new Lru<string, number>(2);
    lru.set('a', 1);
    lru.set('b', 2);
    lru.set('a', 11);
    lru.set('c', 3);
    expect(lru.has('a')).toBe(true);
    expect(lru.has('b')).toBe(false);
    expect(lru.has('c')).toBe(true);
  });

  it('should delete entries and report whether the key existed', () => {
    const lru = new Lru<string, number>(3);
    lru.set('a', 1);
    expect(lru.delete('a')).toBe(true);
    expect(lru.delete('a')).toBe(false);
    expect(lru.has('a')).toBe(false);
    expect(lru.size).toBe(0);
  });

  it('should iterate in MRU-first order', () => {
    const lru = new Lru<string, number>(3);
    lru.set('a', 1);
    lru.set('b', 2);
    lru.set('c', 3);
    expect([...lru.entries()]).toEqual([
      ['c', 3],
      ['b', 2],
      ['a', 1],
    ]);
  });

  it('should iterate updated MRU order after access', () => {
    const lru = new Lru<string, number>(3);
    lru.set('a', 1);
    lru.set('b', 2);
    lru.set('c', 3);
    lru.get('a');
    expect([...lru.entries()].map(([k]) => k)).toEqual(['a', 'c', 'b']);
  });

  it('should clear all entries', () => {
    const lru = new Lru<string, number>(3);
    lru.set('a', 1);
    lru.set('b', 2);
    lru.clear();
    expect(lru.size).toBe(0);
    expect(lru.has('a')).toBe(false);
    expect(lru.has('b')).toBe(false);
    expect([...lru.entries()]).toEqual([]);
  });

  it('should handle deletion of head, middle and tail nodes', () => {
    const lru = new Lru<string, number>(5);
    lru.set('a', 1);
    lru.set('b', 2);
    lru.set('c', 3);
    expect(lru.delete('c')).toBe(true);
    expect(lru.delete('a')).toBe(true);
    expect(lru.delete('b')).toBe(true);
    expect(lru.size).toBe(0);
  });

  it('should keep adding after sequential evictions', () => {
    const lru = new Lru<number, number>(3);
    for (let i = 0; i < 100; i++) lru.set(i, i);
    expect(lru.size).toBe(3);
    expect(lru.has(99)).toBe(true);
    expect(lru.has(0)).toBe(false);
  });
});
