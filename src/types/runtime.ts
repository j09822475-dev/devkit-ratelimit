/**
 * Runtime types — duration parser input shape and a minimal request shim
 * for callers that don't have a full Web-Standard `Request`.
 */

/**
 * Duration accepted by every algorithm factory. Parsed at construction
 * time into integer milliseconds.
 *
 * - `number` — milliseconds (must be a positive finite integer).
 * - Template-literal — `'1m'`, `'500 ms'`, `'1 h'`, `'60 s'`. Uses
 *   `${bigint}` so decimals, signs, exponents and `NaN` are TypeScript
 *   errors at the call site.
 * - Object form — for fractional values (`{ minutes: 1.5 }`).
 */
export type Duration =
  | number
  | `${bigint}${' ' | ''}${'ms' | 's' | 'm' | 'h' | 'd'}`
  | {
      readonly milliseconds?: number;
      readonly seconds?: number;
      readonly minutes?: number;
      readonly hours?: number;
      readonly days?: number;
    };

/**
 * Minimal Web-Standard request shape the limiter actually uses. Enables
 * adapters for runtimes (legacy Express, Workers internal RPCs) where a
 * full `Request` instance isn't available.
 */
export interface MinimalRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Headers;
}
