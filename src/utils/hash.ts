/**
 * Tiny non-cryptographic hashes used for key compaction and stable scope
 * derivation. We deliberately do NOT use `crypto.subtle.digest()` here —
 * those are async and we want a synchronous hash for the request-time
 * `composeKey` path.
 */

const FNV_OFFSET_BASIS_64 = 0xcbf29ce484222325n;
const FNV_PRIME_64 = 0x100000001b3n;

/**
 * FNV-1a 64-bit hash. Returns the result as an unsigned hex string
 * (lowercase, zero-padded to 16 chars). Stable across runtimes.
 *
 * @param input UTF-8 string to hash.
 * @returns     16-char lowercase hex string.
 * @example
 *   fnv1a64('hello') // '779a65e7023cd2e7'
 */
export function fnv1a64(input: string): string {
  let hash = FNV_OFFSET_BASIS_64;
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    // Multi-byte chars hash as their UTF-16 code unit; sufficient for the
    // non-cryptographic scope/key compaction use case.
    hash ^= BigInt(code);
    hash = (hash * FNV_PRIME_64) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, '0');
}

/**
 * djb2 32-bit hash — used as a faster scope discriminator where collision
 * resistance over a small input is acceptable.
 *
 * @param input UTF-8 string to hash.
 * @returns     8-char lowercase hex string.
 */
export function djb2(input: string): string {
  let hash = 5381;
  for (let i = 0; i < input.length; i++) {
    hash = (hash * 33) ^ input.charCodeAt(i);
  }
  // Coerce to unsigned 32-bit and pad.
  return (hash >>> 0).toString(16).padStart(8, '0');
}
