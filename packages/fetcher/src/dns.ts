/**
 * DNS resolution with SSRF validation.
 *
 * All outbound fetches resolve hostnames through `validatingLookup`,
 * which refuses to hand back private, loopback, link-local or reserved
 * addresses. Because validation happens on the exact addresses the
 * socket layer will dial, it also defends against DNS rebinding:
 * a hostname that flips between public and private answers cannot
 * produce a connection to a private address.
 */

import { lookup as dnsLookup } from "node:dns/promises";
import type { LookupAddress } from "node:dns";

export class DnsValidationError extends Error {
  constructor(hostname: string, reason: string) {
    super(`Refused to resolve "${hostname}": ${reason}`);
    this.name = "DnsValidationError";
  }
}

/**
 * Global policy: whether fetching from private networks is permitted.
 *
 * Defaults to false (SSRF protection fully enforced). A self-hosting
 * operator may deliberately enable intranet indexing by setting
 * QUERYNX_ALLOW_PRIVATE_NETWORKS=true. This is an environment-level
 * decision owned by the operator — never settable per API request —
 * so API consumers cannot probe internal networks.
 */
let allowPrivateNetworks =
  process.env.QUERYNX_ALLOW_PRIVATE_NETWORKS === "true";

/** Read the current private-network policy. */
export function isPrivateNetworksAllowed(): boolean {
  return allowPrivateNetworks;
}

/**
 * Set the private-network policy. Returns the previous value so callers
 * (tests, config wiring) can restore it. Not exposed through the API.
 */
export function setPrivateNetworkPolicy(allow: boolean): boolean {
  const previous = allowPrivateNetworks;
  allowPrivateNetworks = allow;
  return previous;
}

/** Whether an IPv4 literal is public (routable, not reserved). */
export function isPublicIpv4(ip: string): boolean {
  const parts = ip.split(".");
  if (parts.length !== 4) return false;
  const octets: number[] = [];
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return false;
    const n = Number(p);
    if (n > 255) return false;
    octets.push(n);
  }
  const [a, b] = [octets[0]!, octets[1]!];

  // Loopback 127/8
  if (a === 127) return false;
  // Private RFC1918
  if (a === 10) return false;
  if (a === 172 && b! >= 16 && b! <= 31) return false;
  if (a === 192 && b === 168) return false;
  // Link-local 169.254/16 (includes cloud metadata 169.254.169.254)
  if (a === 169 && b === 254) return false;
  // Carrier-grade NAT 100.64/10
  if (a === 100 && b! >= 64 && b! <= 127) return false;
  // "This network" 0/8 and broadcast/multicast/reserved 224/4, 240/4
  if (a === 0 || a >= 224) return false;
  // Shared address space 198.18/15 (benchmarking)
  if (a === 198 && (b === 18 || b === 19)) return false;
  return true;
}

/** Whether an IPv6 literal is public. */
export function isPublicIpv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  // Unspecified / loopback
  if (lower === "::" || lower === "::1") return false;
  // IPv4-mapped ::ffff:a.b.c.d — validate the embedded v4
  const v4mapped = lower.match(/^(?:::ffff:)(\d+\.\d+\.\d+\.\d+)$/);
  if (v4mapped) return isPublicIpv4(v4mapped[1]!);
  // IPv4-compatible ::a.b.c.d (deprecated form, still dialable)
  const v4compat = lower.match(/^::(\d+\.\d+\.\d+\.\d+)$/);
  if (v4compat) return isPublicIpv4(v4compat[1]!);
  // Unique local fc00::/7
  if (lower.startsWith("fc") || lower.startsWith("fd")) return false;
  // Link-local fe80::/10
  if (
    lower.startsWith("fe8") ||
    lower.startsWith("fe9") ||
    lower.startsWith("fea") ||
    lower.startsWith("feb")
  )
    return false;
  // 6to4 2002::/16 embeds v4; 6to4 to private v4 is not meaningful but block mapped metadata style
  if (lower.startsWith("2002:")) {
    const hextet = lower.slice(5, 9);
    const a = parseInt(hextet.slice(0, 2), 16);
    const b = parseInt(hextet.slice(2, 4), 16);
    if (!isPublicIpv4(`${a}.${b}.0.1`)) return false;
    return true;
  }
  return true;
}

/** Whether a resolved IP (v4 or v6) is safe for outbound fetching. */
export function isPublicIp(ip: string): boolean {
  return ip.includes(":") ? isPublicIpv6(ip) : isPublicIpv4(ip);
}

/**
 * A dns.lookup-compatible function that validates resolved addresses.
 * Designed to be injected into undici's Agent connect options so that
 * validation and dialing share one resolution result.
 *
 * Contract note: undici (net/tls autoConnect family detection) calls
 * custom lookups with `{ hints, all: true }` and expects the ALL form
 * of the callback — `(err, addresses: LookupAddress[])` — while plain
 * `net.connect` callers may use the single form `(err, address,
 * family)`. This lookup honors `options.all` exactly like
 * `dns.lookup`: when `all` is truthy the callback receives the whole
 * validated array; otherwise a single validated address. The bug this
 * replaced (always single-form) made undici read `undefined` from the
 * array it expected — every hostname fetch failed on real networks.
 */
export function validatingLookup(
  hostname: string,
  options: { family?: number; all?: boolean; hints?: number } & Record<string, unknown>,
  callback: (
    err: NodeJS.ErrnoException | null,
    addressOrList: string | LookupAddress[],
    family?: number,
  ) => void,
): void {
  const wantsAll = options.all === true;
  dnsLookup(hostname, { all: true, verbatim: true, hints: options.hints })
    .then((addresses: LookupAddress[]) => {
      if (addresses.length === 0) {
        const err = new DnsValidationError(hostname, "no addresses returned");
        callback(err, wantsAll ? [] : "", wantsAll ? undefined : 0);
        return;
      }
      const safe = allowPrivateNetworks
        ? addresses
        : addresses.filter((a) => isPublicIp(a.address));
      if (safe.length === 0) {
        const err = new DnsValidationError(
          hostname,
          `resolved to non-public address(es): ${addresses.map((a) => a.address).join(", ")}`,
        );
        callback(err, wantsAll ? [] : "", wantsAll ? undefined : 0);
        return;
      }
      // Hostnames resolving to a mix of public and private addresses get
      // pinned to the public subset only (when the strict policy is on).
      if (wantsAll) {
        callback(null, safe);
      } else {
        callback(null, safe[0]!.address, safe[0]!.family);
      }
    })
    .catch((err: NodeJS.ErrnoException) => {
      callback(err, wantsAll ? [] : "", wantsAll ? undefined : 0);
    });
}
