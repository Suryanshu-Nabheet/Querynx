# Security

## Threat model

Querynx fetches and processes untrusted web content and exposes the
results through an API. Primary threats: SSRF against internal
networks, resource exhaustion, credential leakage and prompt
injection through retrieved content.

## Implemented controls

- **SSRF**: validating DNS resolver rejects loopback, RFC1918,
  link-local (169.254.169.254), CGNAT, multicast and reserved ranges
  for IPv4 and IPv6 including mapped forms; redirects re-validated
  per hop; userinfo stripped from canonical URLs; bracketed IPv6
  literals blocked at the URL layer. Intranet access requires the
  operator-level environment flag — never a request parameter.
- **Resource exhaustion**: byte caps before buffering, extracted
  content length caps, bounded chunk counts, concurrency caps with
  per-provider semaphores, request body limits, cache entry ceilings.
- **Untrusted content**: linkedom parses HTML with zero script
  execution; extracted text is inert data end to end.
- **Credentials**: keys live only in the environment; API keys are
  stored as SHA-256 hashes; logs and audit records pass through
  recursive redaction; auth headers are redacted in request logs.
- **Auth**: constant-time key verification, per-identity token-bucket
  rate limits, revocation support.

## Verified by tests, not claims

The cross-layer attack suite (tests/security) exercises redirect
chains into metadata endpoints, oversized-body bombs, credential
leakage patterns and URL-parsing tricks against the running stack.
It has already caught and driven fixes for two real defects
(userinfo leakage in canonicalization; IPv6-literal bypass).

## Reporting

Open a private security advisory at
https://github.com/Suryanshu-Nabheet/Querynx/security/advisories.
Please include reproduction steps and the affected commit. Do not
open public issues for exploitable findings.
