/**
 * Tiny base64url codec — Web-Standard primitives only. Used by long-key
 * compaction so a hashed key is URL- and Redis-safe.
 */

/**
 * Encode a UTF-8 string to base64url (RFC 4648 §5, no padding).
 *
 * @param input UTF-8 string.
 * @returns     base64url-encoded string.
 */
export function base64urlEncode(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  const b64 = btoa(binary);
  return b64.replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

/**
 * Decode a base64url string back to UTF-8.
 *
 * @param input base64url-encoded string.
 * @returns     The original UTF-8 string.
 * @throws      DOMException when the input is malformed (atob's behaviour).
 */
export function base64urlDecode(input: string): string {
  const padded = input.replaceAll('-', '+').replaceAll('_', '/');
  const padLen = (4 - (padded.length % 4)) % 4;
  const b64 = padded + '='.repeat(padLen);
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
