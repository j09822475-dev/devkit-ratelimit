/**
 * Algorithm specification types — the central discriminated union the engine
 * dispatches on. Variants are branded with a non-exported symbol so a
 * consumer cannot construct one with `as AlgorithmSpec` and bypass the
 * factory's bounds checks; only the algorithm factories (and the sugar
 * overload's internal mint helper) produce branded values.
 */

declare const AlgorithmBrand: unique symbol;

/**
 * Internal brand applied to every {@link AlgorithmSpec} variant. The symbol
 * is not exported, so values of this shape can only originate inside this
 * package.
 */
export type AlgorithmBranded<K extends string> = {
  readonly [AlgorithmBrand]: K;
};

/**
 * Sliding-window counter spec — limit permits per `windowMs`, with a
 * one-window interpolated approximation. Worst-case ~1% overshoot.
 */
export type SlidingWindowCounterSpec = AlgorithmBranded<'sliding-window-counter'> & {
  readonly kind: 'sliding-window-counter';
  readonly limit: number;
  readonly windowMs: number;
};

/**
 * Sliding-window log spec — exact bound, stores per-key timestamps. O(limit)
 * memory per key; pick when accuracy matters more than memory cost.
 */
export type SlidingWindowLogSpec = AlgorithmBranded<'sliding-window-log'> & {
  readonly kind: 'sliding-window-log';
  readonly limit: number;
  readonly windowMs: number;
};

/**
 * Token-bucket spec — `capacity` tokens, refilled at `refill` per `intervalMs`.
 */
export type TokenBucketSpec = AlgorithmBranded<'token-bucket'> & {
  readonly kind: 'token-bucket';
  readonly capacity: number;
  readonly refill: number;
  readonly intervalMs: number;
};

/**
 * Fixed-window spec — `limit` permits per aligned wall-clock window.
 */
export type FixedWindowSpec = AlgorithmBranded<'fixed-window'> & {
  readonly kind: 'fixed-window';
  readonly limit: number;
  readonly windowMs: number;
};

/**
 * Leaky-bucket spec — `capacity` slots, drained at `leak` per `intervalMs`.
 */
export type LeakyBucketSpec = AlgorithmBranded<'leaky-bucket'> & {
  readonly kind: 'leaky-bucket';
  readonly capacity: number;
  readonly leak: number;
  readonly intervalMs: number;
};

/**
 * The discriminated union of every algorithm spec produced by the
 * factories. The store dispatches on `kind` via an exhaustive switch so the
 * type system catches missing cases at compile time.
 */
export type AlgorithmSpec =
  | SlidingWindowCounterSpec
  | SlidingWindowLogSpec
  | TokenBucketSpec
  | FixedWindowSpec
  | LeakyBucketSpec;

/**
 * Discriminator literal — the `kind` field of {@link AlgorithmSpec}.
 */
export type AlgorithmKind = AlgorithmSpec['kind'];

/**
 * Internal helper — applies the brand to a plain object so factories can
 * return branded specs without exposing the symbol publicly.
 *
 * @param spec Spec body without the brand.
 * @returns The same object, typed as the branded variant.
 * @internal
 */
export function brand<S extends { kind: AlgorithmKind }>(
  spec: S,
): S & AlgorithmBranded<S['kind']> {
  // The brand is a phantom type; we only attach the runtime field for shape
  // parity, but since the symbol is module-private the cast is the only way
  // to widen the literal `kind` into the branded variant.
  return spec as S & AlgorithmBranded<S['kind']>;
}
