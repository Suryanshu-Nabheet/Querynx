import { describe, expect, it } from "vitest";
import { JobQueue } from "@querynx/queue";
import { HybridRetrievalEngine } from "@querynx/retrieval";
import { HashEmbedder } from "@querynx/embeddings";
import { SearchOrchestrator } from "@querynx/providers";
import type { SearchProvider, SearchResult } from "@querynx/types";
import { registerHandlers } from "../src/handlers.js";

class StubProvider implements SearchProvider {
  readonly name = "stub";
  isConfigured() {
    return true;
  }
  async search(): Promise<SearchResult[]> {
    return [
      {
        title: "Stub",
        url: "https://example.com/stub",
        snippet: "stub result",
        score: 0.9,
        provider: "stub",
      },
    ];
  }
}

function buildQueue() {
  const queue = new JobQueue({ concurrency: 2, pollIntervalMs: 5 });
  const retrieval = new HybridRetrievalEngine({
    embedder: new HashEmbedder(64),
  });
  registerHandlers({
    queue,
    retrieval,
    embedder: new HashEmbedder(64),
    orchestrator: new SearchOrchestrator([new StubProvider()]),
    userAgent: "QuerynxTest/0.1",
  });
  return { queue, retrieval };
}

describe("worker handlers", () => {
  it("index job validates its payload", async () => {
    const { queue } = buildQueue();
    const job = queue.enqueue("index", { url: "not-a-url" });
    await queue.drain();
    expect(job.status).toBe("dead");
    expect(job.error).toContain("http(s) url");
  });

  it("index job rejects fetch failures as errors (retryable)", async () => {
    const { queue } = buildQueue();
    const job = queue.enqueue("index", {
      url: "https://unreachable.invalid/x",
      maxAttempts: 1,
    });
    await queue.drain();
    expect(job.status).toBe("dead");
    expect(job.error).toBeTruthy();
  });

  it("crawl job validates seeds", async () => {
    const { queue } = buildQueue();
    const job = queue.enqueue("crawl", { seeds: [] }, { maxAttempts: 1 });
    await queue.drain();
    expect(job.status).toBe("dead");
    expect(job.error).toContain("seeds");
  });

  it("research job runs against the stub provider", async () => {
    const { queue } = buildQueue();
    const job = queue.enqueue(
      "research",
      { objective: "test objective", mode: "fast" },
      { maxAttempts: 1 },
    );
    await queue.drain();
    // With an unreachable extraction target the run still completes
    // with evidence from snippets; termination is honest either way.
    const result = (job as typeof job & { result?: Record<string, unknown> })
      .result;
    expect(job.status).toBe("completed");
    expect(["coverage-reached", "budget-exhausted", "no-results"]).toContain(
      result?.termination,
    );
  }, 30_000);
});
