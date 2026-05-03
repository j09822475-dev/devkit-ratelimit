/**
 * Composition primitives — combine multiple limiters into one. Each lives
 * in its own module so a consumer who imports only `composeAll` does not
 * pay for `tieredRateLimiter` or `ruledRateLimiter`.
 */

export { composeAll } from './all.js';
export { composeFirstAllowed } from './first-allowed.js';
export { tieredRateLimiter } from './tiered.js';
export { ruledRateLimiter, type Rule } from './ruled.js';
