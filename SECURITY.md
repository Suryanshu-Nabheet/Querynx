# Security Policy

## Threat model

Querynx fetches and processes untrusted web content and exposes the results
through an API. Primary threats: SSRF against internal networks, resource
exhaustion via oversized/decompression-bomb responses, prompt injection
through retrieved content, and credential leakage.

## Implemented controls

- **SSRF**: outbound fetches resolve DNS through a validating resolver
  (`packages/fetcher/src/dns.ts`) that rejects loopback, RFC1918, link-local
  (including 169.254.169.254), CGNAT, multicast and reserved ranges for
  both IPv4 and IPv6 (including v4-mapped forms). Redirects are followed
  manually with re-validation of every hop. Private-network access is an
  operator-level environment flag (`QUERYNX_ALLOW_PRIVATE_NETWORKS`),
  never a request parameter.
- **Resource exhaustion**: response bodies are byte-capped before
  buffering; extracted content is length-capped; chunk counts are bounded;
  all fan-outs are concurrency-capped with per-provider semaphores and
  timeouts.
- **Untrusted content**: HTML is parsed with linkedom (no script
  execution); extracted text is treated as data, never evaluated.
- **Credentials**: provider API keys live only in the environment; the
  default SearXNG provider requires none.

## Reporting

Open a private security advisory at
https://github.com/Suryanshu-Nabheet/Querynx/security/advisories
or email the repository owner. Please include reproduction steps and
affected commit. Do not open public issues for exploitable findings.

## Known limitations

- Browser-based rendering (planned for JavaScript-heavy pages) is not yet
  implemented; when it lands it will run with network isolation and no
  unnecessary privileges.
- The current release is pre-1.0: contracts may change.
