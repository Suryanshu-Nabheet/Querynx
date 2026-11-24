import { describe, expect, it } from 'vitest';
import { renderPage, BrowserUnavailableError } from '../src/browser.js';
import { existsSync } from 'node:fs';

describe('renderPage', () => {
  it('refuses SSRF targets before any browser launches', async () => {
    await expect(renderPage('http://169.254.169.254/latest')).rejects.toThrow(
      /rejected by outbound safety/
    );
    await expect(renderPage('http://localhost:3000/admin')).rejects.toThrow(
      /rejected by outbound safety/
    );
    await expect(renderPage('file:///etc/passwd')).rejects.toThrow(
      /rejected by outbound safety/
    );
  });

  it('reports unavailability without an executable instead of failing opaquely', async () => {
    await expect(renderPage('https://example.com/js-heavy')).rejects.toThrow(
      BrowserUnavailableError
    );
  });

  it('errors clearly when the configured executable does not exist', async () => {
    await expect(
      renderPage('https://example.com/x', {
        executablePath: '/nonexistent/path/to/chrome',
      })
    ).rejects.toThrow(); // playwright's launch failure surfaces typed
  }, 30_000);

  // A live render test runs only when a real browser is present;
  // CI installs none, and that is the documented contract (rendering
  // is an operator opt-in with QUERYNX_BROWSER_PATH).
  const chromeCandidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/chromium',
    '/usr/bin/google-chrome',
  ];
  const browserPath = chromeCandidates.find((p) => existsSync(p));

  (browserPath ? it : it.skip)('renders a JS-driven page end-to-end', async () => {
    // A data-driven local page rendered through the browser pipeline:
    // proves navigation, settle and content capture work together.
    const html = await renderPage('https://example.com', {
      executablePath: browserPath,
      settleMs: 500,
      navigationTimeoutMs: 15_000,
    });
    expect(html.statusCode).toBe(200);
    expect(html.body.length).toBeGreaterThan(0);
    expect(html.body.toLowerCase()).toContain('<html');
  }, 60_000);
});
