/**
 * Worker service entrypoint.
 *
 * Runs the job queue with crawl/index/research handlers plus the
 * scheduler for recurring jobs. In-process queue by default; the
 * Postgres JobStore drops in when DATABASE_URL is configured
 * (multi-worker safe via SKIP LOCKED claiming).
 */

import { loadAppConfig } from "@querynx/config";
import { JobQueue } from "@querynx/queue";
import { Scheduler } from "@querynx/scheduler";
import { HybridRetrievalEngine } from "@querynx/retrieval";
import { createEmbedder } from "@querynx/embeddings";
import {
  SearchOrchestrator,
  SearxngProvider,
  BraveProvider,
  TavilyProvider,
} from "@querynx/providers";
import { metrics } from "@querynx/observability";
import { registerHandlers } from "./handlers.js";

const config = loadAppConfig();

// Assemble provider set.
const providers = [];
if (config.searxngBaseUrl) {
  providers.push(
    new SearxngProvider({
      baseUrl: config.searxngBaseUrl,
      engines: config.searxngEngines,
    }),
  );
}
if (config.braveApiKey)
  providers.push(new BraveProvider({ apiKey: config.braveApiKey }));
if (config.tavilyApiKey)
  providers.push(new TavilyProvider({ apiKey: config.tavilyApiKey }));
if (providers.length === 0) {
  providers.push(new SearxngProvider({ baseUrl: "http://localhost:8888" }));
}

const orchestrator = new SearchOrchestrator(providers, {
  maxProviderConcurrency: config.providerConcurrency,
  providerTimeoutMs: config.providerTimeoutMs,
});

const embedder = createEmbedder({
  baseUrl: config.embeddingsBaseUrl,
  apiKey: config.embeddingsApiKey,
  model: config.embeddingsModel,
  dimensions: config.embeddingsDimensions,
});

const retrieval = new HybridRetrievalEngine({ embedder });
const queue = new JobQueue({ concurrency: config.workerConcurrency });
const scheduler = new Scheduler();

registerHandlers({
  queue,
  retrieval,
  embedder,
  orchestrator,
  userAgent: "QuerynxBot/0.1 (+https://github.com/Suryanshu-Nabheet/Querynx)",
});

// Recurring jobs arrive as queue schedules; operators add them via the
// API's /v1/schedules surface. Poll loop below fires them.
if (config.workerEnabled) {
  const pollMs = 5_000;
  const tick = () => {
    for (const due of scheduler.pollDue()) {
      queue.enqueue(due.jobType, due.payload, { priority: 1 });
      scheduler.markFired(due.id);
      metrics.inc("worker_scheduled_fires");
    }
  };
  const timer = setInterval(tick, pollMs);
  timer.unref?.();

  // Expose metrics on a side port for scraping.
  const { createServer } = await import("node:http");
  const metricsServer = createServer((req, res) => {
    if (req.url === "/metrics") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(metrics.prometheus());
    } else if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          status: "ok",
          queue: queue.stats(),
          schedules: scheduler.list().length,
        }),
      );
    } else {
      res.writeHead(404).end();
    }
  });
  const metricsPort = config.port + 1;
  metricsServer.listen(metricsPort, config.host);
  console.log(
    `[worker] listening on ${config.host}:${metricsPort} (metrics/health); queue active`,
  );

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      console.log(`[worker] ${signal} received; stopping queue`);
      clearInterval(timer);
      queue.stop();
      metricsServer.close(() => process.exit(0));
    });
  }
} else {
  console.log("[worker] disabled via QUERYNX_DISABLE_WORKER=1");
}
