import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isDev } from '../utils/env.js';

describe('isDev', () => {
  let originalEnv: string | undefined;
  let envExisted: boolean;

  beforeEach(() => {
    envExisted = 'NODE_ENV' in process.env;
    originalEnv = process.env.NODE_ENV;
  });

  afterEach(() => {
    if (envExisted) {
      process.env.NODE_ENV = originalEnv;
    } else {
      delete process.env.NODE_ENV;
    }
  });

  it('should return true when NODE_ENV is "development"', () => {
    process.env.NODE_ENV = 'development';
    expect(isDev()).toBe(true);
  });

  it('should return true when NODE_ENV is unset', () => {
    delete process.env.NODE_ENV;
    expect(isDev()).toBe(true);
  });

  it('should return false when NODE_ENV is "production"', () => {
    process.env.NODE_ENV = 'production';
    expect(isDev()).toBe(false);
  });

  it('should return false when NODE_ENV is "test"', () => {
    process.env.NODE_ENV = 'test';
    expect(isDev()).toBe(false);
  });

  it('should not throw when process is unavailable on the global scope', () => {
    const original = (globalThis as { process?: unknown }).process;
    try {
      (globalThis as { process?: unknown }).process = undefined;
      expect(isDev()).toBe(false);
    } finally {
      (globalThis as { process?: unknown }).process = original;
    }
  });
});
