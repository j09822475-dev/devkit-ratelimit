/**
 * Single portable runtime probe. Bans on `process.env` access elsewhere in
 * the code base flow through this file so Workers / Deno / browser builds
 * stay safe.
 */

/**
 * Detect a development environment heuristically. Returns `true` when
 * `NODE_ENV` is unset or equals `'development'`. On Workers/Deno where
 * `process` is undefined, returns `false` (production-safe default).
 *
 * @returns `true` for development, `false` otherwise.
 */
export function isDev(): boolean {
  // `globalThis.process` may be undefined on Workers / Deno; guard
  // before reading `env`.
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  const env = proc?.env?.['NODE_ENV'];
  return env === undefined || env === 'development';
}
