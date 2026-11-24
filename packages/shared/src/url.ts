/**
 * URL utilities: canonicalization and safety classification.
 */

/** Tracking query parameters removed by canonicalization. */
const TRACKING_PARAMS = new Set([
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "gclid",
  "fbclid",
  "mc_cid",
  "mc_eid",
  "ref",
  "ref_src",
  "ref_url",
]);

/**
 * Canonicalize a URL for storage, dedupe and comparison:
 * - lowercase scheme and host
 * - strip default ports
 * - remove tracking query params
 * - collapse trailing slashes on paths
 * - drop the fragment
 *
 * Returns null when the input is not an absolute http(s) URL.
 */
export function canonicalizeUrl(input: string): string | null {
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return null;
  }

  u.hash = "";
  u.hostname = u.hostname.toLowerCase();
  // Strip credentials: userinfo in canonical URLs is a leakage risk
  // (they end up in logs, cache keys and the index).
  u.username = "";
  u.password = "";

  if (
    (u.protocol === "https:" && u.port === "443") ||
    (u.protocol === "http:" && u.port === "80")
  ) {
    u.port = "";
  }

  for (const param of [...TRACKING_PARAMS]) {
    u.searchParams.delete(param);
  }

  u.pathname = u.pathname.replace(/\/{2,}/g, "/");
  if (u.pathname !== "/" && u.pathname.endsWith("/")) {
    u.pathname = u.pathname.replace(/\/+$/, "");
  }

  return u.toString();
}

/** Extract the registrable domain (e.g. "example.co.uk" -> "example.co.uk"). */
export function extractDomain(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

/**
 * Normalize a domain filter entry: accepts "example.com", "https://example.com",
 * "www.example.com" and "*.example.com" and returns the bare lowercase domain
 * for suffix matching.
 */
export function normalizeDomainFilter(domain: string): string {
  const trimmed = domain.trim().toLowerCase();
  const withoutProtocol = trimmed.replace(/^https?:\/\//, "");
  const withoutWildcard = withoutProtocol.replace(/^\*\./, "");
  return withoutWildcard.replace(/\/+$/, "").replace(/^www\./, "");
}

/**
 * Check whether a URL's domain passes include/exclude filters.
 * A filter matches when the URL host equals the filter or is a subdomain.
 */
export function domainMatches(url: string, filter: string): boolean {
  const host = extractDomain(url);
  if (!host) return false;
  const f = normalizeDomainFilter(filter);
  if (!f) return false;
  return host === f || host.endsWith(`.${f}`);
}

/** Validate a list of include/exclude domain filters against a URL. */
export function passesDomainFilters(
  url: string,
  include?: readonly string[],
  exclude?: readonly string[],
): boolean {
  if (include && include.length > 0) {
    const ok = include.some((d) => domainMatches(url, d));
    if (!ok) return false;
  }
  if (exclude && exclude.length > 0) {
    const blocked = exclude.some((d) => domainMatches(url, d));
    if (blocked) return false;
  }
  return true;
}

/**
 * Classify URL safety for outbound fetching (SSRF defense, first layer).
 * The fetcher package adds resolution-time validation on top of this.
 */
export function isSafeOutboundUrl(input: string): boolean {
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  const host = u.hostname.toLowerCase().toLowerCase();
  if (host === "") return false;
  // Reject literal loopback / link-local / private network targets and
  // cloud metadata endpoints. DNS resolution checks happen in the fetcher.
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host === "metadata.google.internal" ||
    host === "169.254.169.254"
  ) {
    return false;
  }
  if (isPrivateIpv4(host)) return false;
  // Bracketed IPv6 literals ([::1], [fe80::1], ...): validate the inner
  // address with the full resolver-grade checks. NOTE: the WHATWG URL
  // parser NORMALIZES embedded IPv4 (e.g. [::ffff:169.254.169.254]
  // arrives as ::ffff:a9fe:a9fe), so the decoder below must handle the
  // hex-compressed mapped form — matching dotted quads only would let
  // compressed mapped metadata addresses through (audit finding).
  const v6 = host.match(/^\[(.+)\]$/);
  if (v6) {
    const addr = v6[1]!.toLowerCase();
    if (addr === "::" || addr === "::1") return false;
    // Dotted mapped form.
    const mapped = addr.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped && isPrivateIpv4(mapped[1]!)) return false;
    // Hex-compressed mapped form: last two hextets encode the v4 pair
    // (a9fe:a9fe == 169.254.169.254).
    const compressed = addr.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (compressed) {
      const hi = parseInt(compressed[1]!, 16);
      const lo = parseInt(compressed[2]!, 16);
      const v4 = `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
      if (isPrivateIpv4(v4)) return false;
    }
    if (addr.startsWith("fc") || addr.startsWith("fd")) return false; // unique local
    if (/^fe[89ab]/.test(addr)) return false; // link local fe80::/10
    return true;
  }
  return true;
}

/** Whether a hostname is a private/reserved IPv4 literal. */
export function isPrivateIpv4(host: string): boolean {
  const parts = host.split(".");
  if (parts.length !== 4) return false;
  const octets: number[] = [];
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return false;
    const n = Number(p);
    if (n > 255) return false;
    octets.push(n);
  }
  const [a, b] = [octets[0]!, octets[1]!];
  if (a === 10 || a === 127) return true;
  if (a === 172 && b! >= 16 && b! <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  if (a === 0 || a >= 224) return true;
  return false;
}
