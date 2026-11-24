import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { createHmac } from 'node:crypto';
import { deliverWebhook, validWebhookTarget, signWebhook } from '../src/webhooks.js';
import { setPrivateNetworkPolicy } from '@querynx/fetcher';

let receiver: Server;
let receiverUrl: string;
let received: Array<{ headers: Record<string, string | string[] | undefined>; body: unknown }> = [];
let failFirstN = 2;
let hits = 0;

/**
 * The webhook receiver fixture listens on loopback; like the fetcher
 * suite, tests toggle the operator policy to exercise mechanics while
 * separate assertions keep proving strict-mode blocking.
 */
beforeAll(async () => {
  setPrivateNetworkPolicy(true);
  receiver = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      hits++;
      received.push({ headers: req.headers, body: JSON.parse(body) });
      if (hits <= failFirstN) {
        res.writeHead(500).end();
        return;
      }
      res.writeHead(200).end('ok');
    });
  });
  await new Promise<void>((r) => receiver.listen(0, '127.0.0.1', r));
  receiverUrl = `http://127.0.0.1:${(receiver.address() as { port: number }).port}`;
});

afterAll(async () => {
  setPrivateNetworkPolicy(false);
  await new Promise<void>((r) => receiver.close(() => r()));
});

describe('signWebhook', () => {
  it('produces a stable HMAC the receiver can verify', () => {
    const signature = signWebhook('{"a":1}', 'secret');
    expect(signature).toMatch(/^sha256=[0-9a-f]{64}$/);
    const expected = `sha256=${createHmac('sha256', 'secret').update('{"a":1}').digest('hex')}`;
    expect(signature).toBe(expected);
  });
});

describe('validWebhookTarget', () => {
  it('accepts public endpoints', () => {
    expect(validWebhookTarget('https://hooks.example.com/research')).toBe(true);
  });

  it('rejects internal targets like any fetch', () => {
    expect(validWebhookTarget('http://169.254.169.254/latest')).toBe(false);
    expect(validWebhookTarget('http://localhost:9/admin')).toBe(false);
    expect(validWebhookTarget('http://10.0.0.5/internal')).toBe(false);
  });
});

describe('deliverWebhook', () => {
  it('delivers with retries and signs when a secret is configured', async () => {
    received = [];
    failFirstN = 2;
    hits = 0;

    const result = await deliverWebhook(
      {
        url: receiverUrl,
        event: 'research.completed',
        payload: { objective: 'webhook test' },
        requestId: 'req-1',
      },
      { secret: 'whsec' }
    );

    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(3);
    expect(result.statusCode).toBe(200);

    const first = received[0]!;
    expect(first.headers['x-querynx-event']).toBe('research.completed');
    expect(typeof first.headers['x-querynx-signature']).toBe('string');
    // The signature matches the raw body the receiver saw.
    const rawBody = JSON.stringify({
      event: 'research.completed',
      requestId: 'req-1',
      deliveredAt: (first.body as { deliveredAt: string }).deliveredAt,
      payload: { objective: 'webhook test' },
    });
    expect(first.headers['x-querynx-signature']).toBe(
      `sha256=${createHmac('sha256', 'whsec').update(rawBody).digest('hex')}`
    );
    expect((first.body as { payload: { objective: string } }).payload.objective).toBe('webhook test');
  });

  it('gives up after bounded attempts without throwing', async () => {
    failFirstN = 99; // always fail
    hits = 0;
    const result = await deliverWebhook(
      {
        url: receiverUrl,
        event: 'research.completed',
        payload: {},
        requestId: 'req-2',
      }
    );
    expect(result.ok).toBe(false);
    expect(result.attempts).toBeLessThanOrEqual(3);
    expect(result.error).toContain('500');
    failFirstN = 0;
  }, 30_000);

  it('reports unreachable targets without throwing', async () => {
    const result = await deliverWebhook({
      url: 'http://127.0.0.1:1/nope',
      event: 'research.completed',
      payload: {},
      requestId: 'req-3',
    });
    expect(result.ok).toBe(false);
    expect(result.attempts).toBeLessThanOrEqual(3);
  }, 30_000);
});
