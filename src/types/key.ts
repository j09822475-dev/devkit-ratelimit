/**
 * Key extractor types. The default key generator inspects standard CDN
 * headers (`cf-connecting-ip`, `x-real-ip`, `x-forwarded-for`); consumers
 * can supply their own to bucket against API keys, tenants, or composite
 * identifiers.
 */

/**
 * Optional context object passed to {@link KeyGenerator}, carrying any
 * framework-supplied fields. The core never populates `tenant`; framework
 * adapters may.
 */
export interface KeyGeneratorContext {
  /** Cloudflare-supplied client IP, if available. */
  readonly connectingIp?: string;
  /** Vercel/Next.js geo info, if available. */
  readonly geo?: { readonly country?: string; readonly region?: string };
  /**
   * Tenant id resolved by an upstream middleware, if your framework
   * adapter forwarded it. The core never populates this; framework
   * adapters MAY.
   */
  readonly tenant?: string;
}

/**
 * Structured payload returned by a key generator that wants to thread a
 * typed `context` through the result.
 *
 * @typeParam K Caller-defined context payload type.
 */
export interface StructuredKey<K> {
  readonly key: string;
  readonly context: K;
}

/**
 * Function called once per request to extract the bucketing key.
 *
 * The function may return either a bare string (the key), `null` /
 * `undefined` / `''` to skip rate limiting, or a structured
 * `{ key, context }` payload with a typed context. Throws are honoured by
 * `failOpen` — fail-closed (default) wraps the cause in
 * `INVALID_KEY`; fail-open swallows the throw and returns
 * `{ allowed: true, degraded: true }`.
 *
 * @typeParam K Caller-defined context payload returned alongside the key.
 */
export type KeyGenerator<K = undefined> = (
  req: Request,
  ctx: KeyGeneratorContext,
) =>
  | string
  | null
  | undefined
  | StructuredKey<K>
  | Promise<string | null | undefined | StructuredKey<K>>;
