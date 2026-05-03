/**
 * Narrow Redis client interface — the adapter does NOT import `ioredis` or
 * `redis@^4`; bring your own client. Both satisfy this shape natively.
 */

/**
 * Minimum Redis client shape required by {@link createRedisStore}. The
 * adapter prefers `evalsha` after the first `eval` registration; clients
 * that don't support `scriptLoad` (older REST gateways) are still
 * supported via the `eval` fallback.
 */
export interface RedisLike {
  /**
   * EVAL — execute a Lua script.
   *
   * @param script Lua script body.
   * @param keys   Number of keys following.
   * @param args   Keys, then arguments.
   * @returns      Whatever the script `return`s, in Redis reply form.
   */
  eval(script: string, keys: number, ...args: (string | number)[]): Promise<unknown>;
  /**
   * EVALSHA — execute a previously-loaded Lua script by SHA digest.
   *
   * @param sha  SHA1 digest from `scriptLoad`.
   * @param keys Number of keys following.
   * @param args Keys, then arguments.
   * @returns    Same shape as `eval`.
   */
  evalsha(sha: string, keys: number, ...args: (string | number)[]): Promise<unknown>;
  /**
   * Optional SCRIPT LOAD — pre-load a script and obtain its SHA. Adapters
   * that don't support it fall back to repeated `eval` calls.
   *
   * @param script Lua script body.
   * @returns      SHA1 digest of the script.
   */
  scriptLoad?(script: string): Promise<string>;
}
