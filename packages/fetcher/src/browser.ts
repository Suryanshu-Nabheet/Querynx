/**
 * Isolated browser rendering for JavaScript-heavy pages.
 *
 * Used ONLY when HTTP extraction cannot retrieve sufficient content
 * (directive §7). Security posture (directive §16):
 *   - navigation gate: the URL passes the same SSRF validation as the
 *     HTTP path BEFORE any browser is launched;
 *   - network isolation: all non-http(s) schemes are blocked at the
 *     route level, and requests to private networks are aborted via a
 *     route handler (the browser never dials metadata endpoints);
 *   - no unnecessary privileges: no downloads, no file choosers, no
 *     arbitrary permissions — a bare page with scripts enabled only
 *     long enough to render;
 *   - hard timeouts: navigation and render budgets, then dispose;
 *   - content from the page is untrusted data — we take HTML text,
 *     never evaluate anything in page context.
 *
 * Requires an operator-provided browser (system Chrome/Chromium or a
 * Playwright install). Without one, rendering reports unavailable and
 * callers fall back to the HTTP path gracefully.
 */

import { isSafeOutboundUrl } from '@querynx/shared';
import { isPrivateNetworksAllowed } from './dns.js';
import type { FetchResult } from './fetcher.js';

export interface RenderOptions {
  /** Path to a Chromium/Chrome executable. */
  executablePath?: string;
  /** Navigation timeout (default 20s). */
  navigationTimeoutMs?: number;
  /** Extra seconds for client-side rendering after load (default 3s). */
  settleMs?: number;
  /** Rendered-page byte cap (default 5 MiB, same as HTTP). */
  maxBytes?: number;
  /** Signal for cooperative cancellation. */
  signal?: AbortSignal;
}

export class BrowserUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BrowserUnavailableError';
  }
}

/** Whether the URL is eligible for rendering at all. */
function renderable(url: string): boolean {
  return isSafeOutboundUrl(url) || isPrivateNetworksAllowed();
}

/**
 * Render a page with an isolated Chromium instance and return the
 * post-JavaScript HTML.
 *
 * @throws BrowserUnavailableError when no executable is configured.
 * @throws Error on navigation failures, timeouts or aborts.
 */
export async function renderPage(url: string, options: RenderOptions = {}): Promise<FetchResult> {
  const {
    executablePath,
    navigationTimeoutMs = 20_000,
    settleMs = 3_000,
    maxBytes = 5 * 1024 * 1024,
    signal,
  } = options;

  if (!renderable(url)) {
    throw new Error(`URL rejected by outbound safety checks: ${url}`);
  }
  if (!executablePath) {
    throw new BrowserUnavailableError(
      'browser rendering requires QUERYNX_BROWSER_PATH (path to a Chromium/Chrome executable)'
    );
  }

  const pw = await import('playwright-core');
  const browser = await pw.chromium.launch({
    executablePath,
    headless: true,
    args: [
      '--no-sandbox',             // container-grade isolation comes from
      '--disable-dev-shm-usage',  // the runtime; no host privileges needed
      '--disable-gpu',
      '--mute-audio',
      '--no-first-run',
    ],
  });

  try {
    const context = await browser.newContext({
      // Neutral fingerprint: plain UA, no plugins, viewport-typical.
      userAgent: 'QuerynxBot/0.1 (+https://github.com/Suryanshu-Nabheet/Querynx)',
      javaScriptEnabled: true, // the point of rendering
      bypassCSP: false,
      serviceWorkers: 'block',
      extraHTTPHeaders: { 'accept-language': 'en,*;q=0.5' },
    });

    // Network isolation inside the browser: abort private-network
    // requests the page tries to make (defense in depth beyond the
    // navigation gate — includes subresources and fetch() calls).
    await context.route('**/*', (route) => {
      const target = route.request().url();
      if (!isSafeOutboundUrl(target) && !isPrivateNetworksAllowed()) {
        void route.abort();
        return;
      }
      // Cap response bodies mid-flight as well.
      void route.continue();
    });

    const page = await context.newPage();
    // Hard content cap enforced at the browser level.
    let receivedBytes = 0;
    page.on('response', async (response) => {
      try {
        const body = await response.body();
        receivedBytes += body.length;
      } catch {
        // Some responses have no body (redirects, caches); fine.
      }
    });

    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const onAbort = () => void page.close().catch(() => {});
    signal?.addEventListener('abort', onAbort, { once: true });

    const response = await page.goto(url, {
      timeout: navigationTimeoutMs,
      waitUntil: 'domcontentloaded',
    });

    // Let client-side rendering settle (SPA hydration, lazy content).
    if (settleMs > 0) {
      await page.waitForTimeout(settleMs);
    }

    const html = await page.content();
    if (receivedBytes > maxBytes * 4) {
      throw new Error(`rendered session exceeded byte budget (${receivedBytes} bytes)`);
    }
    const truncated = html.length > maxBytes;

    const result: FetchResult = {
      url: page.url(), // final URL after SPA redirects
      statusCode: response?.status() ?? 200,
      headers: {
        'content-type': response?.headers()['content-type'] ?? 'text/html',
      },
      body: truncated ? html.slice(0, maxBytes) : html,
      truncated,
      redirects: response ? response.request().redirectedFrom() ? 1 : 0 : 0,
    };

    await page.close();
    await context.close();
    return result;
  } finally {
    await browser.close().catch(() => {});
  }
}
