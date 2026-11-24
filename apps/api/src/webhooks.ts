/**
 * Webhook delivery for completed research jobs (directive §14).
 *
 * Operators register webhook URLs; when a research request carries a
 * webhook, the API delivers the completed report as a signed POST
 * after responding to the caller. Delivery is fire-and-forget with
 * bounded retries — webhook failures never fail the research request.
 *
 * Security: webhook targets pass the same SSRF validation as fetches
 * (an attacker-registered webhook pointing at internal services is
 * rejected), payloads are capped, and every delivery is signed with an
 * HMAC over the body so receivers can verify authenticity.
 */

import { createHmac, randomUUID } from 'node:crypto';
import { Agent, request as undiciRequest } from 'undici';
import { isSafeOutboundUrl } from '@querynx/shared';
import { validatingLookup } from '@querynx/fetcher';

export interface WebhookDelivery {
  url: string;
  event: 'research.completed';
  payload: Record<string, unknown>;
  requestId: string;
}

export interface WebhookResult {
  url: string;
  ok: boolean;
  statusCode: number;
  attempts: number;
  error?: string;
}

/** Compute the HMAC-SHA256 signature header value for a body. */
export function signWebhook(body: string, secret: string): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

/**
 * Deliver a webhook with bounded retries (2 attempts, backoff between).
 * Never throws: callers treat delivery as best-effort.
 */
export async function deliverWebhook(
  delivery: WebhookDelivery,
  options: { secret?: string; timeoutMs?: number } = {}
): Promise<WebhookResult> {
  const { secret, timeoutMs = 10_000 } = options;
  const body = JSON.stringify({
    event: delivery.event,
    requestId: delivery.requestId,
    deliveredAt: new Date().toISOString(),
    payload: delivery.payload,
  });

  let attempts = 0;
  let lastError: string | undefined;
  let lastStatus = 0;

  for (let attempt = 0; attempt < 3; attempt++) {
    attempts++;
    try {
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        'x-querynx-event': delivery.event,
        'x-querynx-delivery': randomUUID(),
      };
      if (secret) {
        headers['x-querynx-signature'] = signWebhook(body, secret);
      }
      // Fresh dispatcher per delivery: the shared fetcher agent caches
      // its DNS policy at creation, and webhook delivery must honor
      // the current policy (tests toggle it; operators set it at boot).
      const agent = new Agent({
        connect: { timeout: Math.min(timeoutMs, 10_000), lookup: validatingLookup as never },
      });
      try {
        const response = await undiciRequest(delivery.url, {
          dispatcher: agent,
          method: 'POST',
          headersTimeout: timeoutMs,
          bodyTimeout: timeoutMs,
          headers,
          body,
        });
        lastStatus = response.statusCode;
        await response.body.dump();
        if (response.statusCode >= 200 && response.statusCode < 300) {
          return { url: delivery.url, ok: true, statusCode: response.statusCode, attempts };
        }
        lastError = `HTTP ${response.statusCode}`;
      } finally {
        await agent.close().catch(() => {});
      }
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    if (attempt < 2) {
      await new Promise((r) => setTimeout(r, 1_000));
    }
  }

  return {
    url: delivery.url,
    ok: false,
    statusCode: lastStatus,
    attempts,
    error: lastError,
  };
}

/** Validate a webhook target: only public http(s) endpoints. */
export function validWebhookTarget(url: string): boolean {
  return isSafeOutboundUrl(url);
}
