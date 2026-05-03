/**
 * Key composition + the default extractor. The default extractor inspects
 * `cf-connecting-ip`, `x-real-ip`, then the first hop of `x-forwarded-for`
 * — never falls back to `''` because that would funnel every request
 * behind a misconfigured proxy into a single bucket.
 */

import type { KeyGenerator, KeyGeneratorContext } from '../types/key.js';

const IPV4_MAPPED_RE = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i;

/**
 * Compose a fully-qualified store key from `prefix`, `scope` and the
 * caller-supplied user key. Empty `prefix` is allowed for advanced users.
 *
 * @param prefix  Store prefix (often `'rl'`).
 * @param scope   Logical scope name.
 * @param userKey User-supplied bucketing key.
 * @returns       The composed key (`prefix:scope:userKey`).
 * @example
 *   composeKey('rl', 'sliding-window:1m', '1.2.3.4'); // 'rl:sliding-window:1m:1.2.3.4'
 */
export function composeKey(prefix: string, scope: string, userKey: string): string {
  if (prefix === '' && scope === '') return userKey;
  if (prefix === '') return `${scope}:${userKey}`;
  if (scope === '') return `${prefix}:${userKey}`;
  return `${prefix}:${scope}:${userKey}`;
}

/**
 * Extract the first hop from a comma-separated `x-forwarded-for` header.
 * Trims whitespace; returns `null` for an empty input.
 *
 * @param raw Raw header value.
 * @returns   First hop, or `null`.
 */
function firstForwardedHop(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined || raw === '') return null;
  const comma = raw.indexOf(',');
  const first = comma === -1 ? raw : raw.slice(0, comma);
  const trimmed = first.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Normalise an IPv4-mapped IPv6 address (`::ffff:1.2.3.4`) to its IPv4
 * form, so a dual-stack client doesn't double-bucket.
 *
 * @param ip Raw IP address string.
 * @returns  Normalised IP address.
 */
function normaliseIp(ip: string): string {
  const m = IPV4_MAPPED_RE.exec(ip);
  return m === null ? ip : (m[1] as string);
}

/**
 * Options for {@link defaultKeyGeneratorWith}.
 */
export interface DefaultKeyGeneratorOptions {
  /**
   * If set, IPv6 addresses are collapsed to the leading `prefix` bits.
   * Off by default — legitimate large IPv6 networks (mobile carriers)
   * would otherwise collide.
   */
  readonly ipv6Prefix?: number;
}

/**
 * Build a key generator that inspects standard CDN headers.
 *
 * Order of fields consulted (first non-empty wins):
 *   1. `connectingIp` from `KeyGeneratorContext` (Cloudflare workers `cf`).
 *   2. `cf-connecting-ip` header.
 *   3. `x-real-ip` header.
 *   4. First hop of `x-forwarded-for` header.
 *
 * Returns `null` when none are present, so the limiter skips rather than
 * bucketing every request behind a misconfigured proxy into `''`.
 *
 * @param opts Optional tuning (e.g. IPv6 collapse).
 * @returns    A key generator suitable as `keyGenerator` in `RateLimitConfig`.
 */
export function defaultKeyGeneratorWith(
  opts: DefaultKeyGeneratorOptions = {},
): KeyGenerator<undefined> {
  const ipv6Prefix = opts.ipv6Prefix;
  return (req: Request, ctx: KeyGeneratorContext): string | null => {
    const headers = req.headers;
    const candidate =
      ctx.connectingIp ??
      headers.get('cf-connecting-ip') ??
      headers.get('x-real-ip') ??
      firstForwardedHop(headers.get('x-forwarded-for'));
    if (candidate === null || candidate === undefined || candidate === '') return null;
    let ip = normaliseIp(candidate.trim());
    if (ipv6Prefix !== undefined && ip.includes(':')) {
      ip = collapseIpv6(ip, ipv6Prefix);
    }
    return ip;
  };
}

/**
 * Default key generator — convenience wrapper around
 * {@link defaultKeyGeneratorWith} with no options. Suitable for direct
 * use as a {@link KeyGenerator}.
 */
export const defaultKeyGenerator: KeyGenerator<undefined> = defaultKeyGeneratorWith();

/**
 * Collapse an IPv6 address to its leading `prefix` bits.
 *
 * @param ip     IPv6 address.
 * @param prefix Prefix length (e.g. 64).
 * @returns      A canonical "prefix" representation safe to use as a key.
 */
function collapseIpv6(ip: string, prefix: number): string {
  // We don't decode the address fully — we collapse on hex groups instead.
  // Each group is 16 bits; round down to the nearest group.
  const groupCount = Math.max(1, Math.min(8, Math.floor(prefix / 16)));
  const expanded = expandIpv6(ip);
  return expanded.slice(0, groupCount).join(':') + `::/${prefix}`;
}

/**
 * Expand an IPv6 address into its eight 16-bit groups.
 *
 * @param ip Compressed IPv6 address (e.g. `2001:db8::1`).
 * @returns  Eight lowercase hex groups.
 */
function expandIpv6(ip: string): string[] {
  const lower = ip.toLowerCase();
  const idx = lower.indexOf('::');
  if (idx === -1) return lower.split(':');
  const left = idx === 0 ? [] : lower.slice(0, idx).split(':');
  const right = idx + 2 === lower.length ? [] : lower.slice(idx + 2).split(':');
  const fill = 8 - left.length - right.length;
  return [...left, ...new Array<string>(fill).fill('0'), ...right];
}
