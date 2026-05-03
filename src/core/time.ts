/**
 * Single time source for the limiter. Every clock read in the engine goes
 * through this indirection so tests and distributed deployments can
 * replace `Date.now()` with a custom function via `config.clock`.
 */

/**
 * Default clock — just `Date.now`.
 *
 * @returns Wall-clock milliseconds since the Unix epoch.
 */
export function nowMs(): number {
  return Date.now();
}
