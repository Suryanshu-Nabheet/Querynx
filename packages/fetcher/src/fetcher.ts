/**
 * The Querynx fetcher: SSRF-hardened HTTP client for all outbound traffic.
 *
 * Layers of defense:
 *  1. URL validation (scheme, host classification) before any I/O.
 *  2. DNS resolution pinned to public addresses only (rebinding defense).
 *  3. Redirect handling that re-validates every hop target.
 *  4. Hard limits: response size, timeout, decompression output.
 *
 * The same validation function powers crawl-time discovery, so nothing
 * in Querynx can dial a private network by accident.
 */

import { Agent, request as undiciRequest, Dispatcher } from "undici";
import { isSafeOutboundUrl } from "@querynx/shared";
import {
  validatingLookup,
  DnsValidationError,
  isPrivateNetworksAllowed,
} from "./dns.js";

export { DnsValidationError } from "./dns.js";
export {
  isPublicIp,
  isPublicIpv4,
  isPublicIpv6,
  setPrivateNetworkPolicy,
  isPrivateNetworksAllowed,
} from "./dns.js";

export interface FetcherOptions {
  /** Per-request timeout (default 15s). */
  timeoutMs?: number;
  /** Maximum response body bytes (default 5 MiB). */
  maxBytes?: number;
  /** Maximum redirect hops (default 5). */
  maxRedirects?: number;
  /** Identifying User-Agent for politeness. */
  userAgent?: string;
  /** Extra headers to send on every request. */
  headers?: Record<string, string>;
  /** Signal for cooperative cancellation. */
  signal?: AbortSignal;
}

export interface FetchResult {
  /** Final URL after redirects. */
  url: string;
  statusCode: number;
  headers: Record<string, string>;
  /** Response body as UTF-8 text, bounded by maxBytes. */
  body: string;
  /** Whether the body was truncated at maxBytes. */
  truncated: boolean;
  /** Number of redirects followed. */
  redirects: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_REDIRECTS = 5;
const DEFAULT_UA =
  "QuerynxBot/0.1 (+https://github.com/Suryanshu-Nabheet/Querynx)";

/**
 * Shared dispatcher with validating DNS lookup. One pool per process is
 * fine: undici connections are multiplexed over HTTP/1.1 keep-alive.
 */
let sharedAgent: Agent | undefined;

function getAgent(): Agent {
  if (!sharedAgent) {
    sharedAgent = new Agent({
      connect: {
        timeout: 10_000,
        lookup: validatingLookup as never,
      },
      connections: 64,
      pipelining: 1,
      keepAliveTimeout: 30_000,
      keepAliveMaxTimeout: 120_000,
    });
  }
  return sharedAgent;
}

/** Change-protocol/host redirect edge cases we refuse to follow. */
class RedirectLoopError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RedirectLoopError";
  }
}

/**
 * Fetch a URL with full SSRF protection. The URL is validated before
 * any connection is made, and every redirect hop re-validates.
 *
 * @throws DnsValidationError when the host resolves to private space.
 * @throws RedirectLoopError when redirect limits are exceeded.
 */
export async function fetchUrl(
  url: string,
  options: FetcherOptions = {},
): Promise<FetchResult> {
  const {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxBytes = DEFAULT_MAX_BYTES,
    maxRedirects = DEFAULT_MAX_REDIRECTS,
    userAgent = DEFAULT_UA,
    headers = {},
    signal,
  } = options;

  let currentUrl = url;
  let redirects = 0;
  let truncated = false;

  for (;;) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    if (!isSafeOutboundUrl(currentUrl) && !isPrivateNetworksAllowed()) {
      throw new DnsValidationError(
        currentUrl,
        "URL rejected by outbound safety checks",
      );
    }

    let response: Dispatcher.ResponseData;
    try {
      response = await undiciRequest(currentUrl, {
        dispatcher: getAgent(),
        method: "GET",
        headersTimeout: timeoutMs,
        bodyTimeout: timeoutMs,
        headers: {
          "user-agent": userAgent,
          accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.8,*/*;q=0.7",
          "accept-language": "en;q=0.9,*;q=0.5",
          ...headers,
        },
      }).catch((err: unknown) => {
        if (err instanceof Error && /aborted/i.test(err.message)) {
          throw new DOMException("Aborted", "AbortError");
        }
        throw err;
      });
    } catch (err) {
      if (err instanceof DnsValidationError) throw err;
      if (err instanceof DOMException) throw err;
      throw new Error(
        `Fetch failed for ${currentUrl}: ${(err as Error).message}`,
      );
    }

    const status = response.statusCode;

    // Handle redirects manually so every hop is re-validated.
    if (status >= 300 && status < 400) {
      const location = response.headers.location;
      if (typeof location !== "string" || location === "") {
        throw new RedirectLoopError(
          `Redirect ${status} without Location header from ${currentUrl}`,
        );
      }
      if (redirects >= maxRedirects) {
        throw new RedirectLoopError(
          `Exceeded ${maxRedirects} redirects starting at ${url}`,
        );
      }
      const next = new URL(location, currentUrl).toString();
      // Drain the body before following.
      await response.body.dump();
      if (next === currentUrl) {
        throw new RedirectLoopError(`Redirect loop at ${currentUrl}`);
      }
      currentUrl = next;
      redirects++;
      continue;
    }

    // Stream the body with a hard byte cap.
    const declaredLength = Number(response.headers["content-length"] ?? 0);
    if (declaredLength > maxBytes) {
      await response.body.dump();
      truncated = true;
      return {
        url: currentUrl,
        statusCode: status,
        headers: response.headers as Record<string, string>,
        body: "",
        truncated,
        redirects,
      };
    }

    const chunks: Buffer[] = [];
    let received = 0;
    for await (const chunk of response.body) {
      received += (chunk as Buffer).length;
      if (received > maxBytes) {
        chunks.length = 0;
        try {
          await response.body.destroy();
        } catch {
          // destroy() may throw if the stream already errored; ignore.
        }
        truncated = true;
        break;
      }
      chunks.push(chunk as Buffer);
    }

    return {
      url: currentUrl,
      statusCode: status,
      headers: response.headers as Record<string, string>,
      body: truncated ? "" : Buffer.concat(chunks).toString("utf-8"),
      truncated,
      redirects,
    };
  }
}

/** Test hook: replace the shared dispatcher. */
export function setFetcherAgent(agent: Agent): void {
  sharedAgent = agent;
}

/** Test hook: reset to the default agent. */
export function resetFetcherAgent(): void {
  sharedAgent = undefined;
}
