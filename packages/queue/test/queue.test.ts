import { describe, expect, it } from "vitest";
import { JobQueue } from "../src/index.js";

describe("JobQueue", () => {
  it("executes jobs through registered handlers", async () => {
    const q = new JobQueue({ concurrency: 1 });
    q.handle("echo", async (payload) => ({ echoed: payload["x"] }));
    const job = q.enqueue("echo", { x: 42 });
    await q.drain();
    expect(job.status).toBe("completed");
    expect((job as typeof job & { result?: unknown }).result).toEqual({
      echoed: 42,
    });
  });

  it("runs jobs concurrently up to the limit", async () => {
    let active = 0;
    let peak = 0;
    const q = new JobQueue({ concurrency: 3, pollIntervalMs: 5 });
    q.handle("slow", async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 30));
      active--;
    });
    for (let i = 0; i < 6; i++) q.enqueue("slow", {});
    await q.drain();
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBe(3);
  });

  it("orders jobs by priority", async () => {
    const q = new JobQueue({ concurrency: 1, pollIntervalMs: 5 });
    const order: string[] = [];
    q.handle("p", async (payload) => {
      order.push(String(payload["name"]));
    });
    q.enqueue("p", { name: "low" }, { priority: 1 });
    q.enqueue("p", { name: "high" }, { priority: 10 });
    q.enqueue("p", { name: "mid" }, { priority: 5 });
    await q.drain();
    expect(order).toEqual(["high", "mid", "low"]);
  });

  it("retries failed jobs with backoff then dead-letters", async () => {
    // Real timers: the queue's backoff scheduling is what's under test.
    const q = new JobQueue({
      concurrency: 1,
      maxAttempts: 2,
      pollIntervalMs: 5,
    });
    let attempts = 0;
    q.handle("flaky", async () => {
      attempts++;
      throw new Error("nope");
    });
    const job = q.enqueue("flaky", {});
    await q.drain();
    expect(attempts).toBe(2);
    expect(job.status).toBe("dead");
    expect(job.error).toBe("nope");
    expect(q.deadLetters()).toHaveLength(1);
  });

  it("dead-letters unhandled job types", async () => {
    const q = new JobQueue({ concurrency: 1 });
    const job = q.enqueue("unknown-type", {});
    await q.drain();
    expect(job.status).toBe("dead");
    expect(job.error).toContain("no handler");
  });

  it("cancels pending jobs", async () => {
    const q = new JobQueue({ concurrency: 1, pollIntervalMs: 5 });
    q.handle("slow", async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    const a = q.enqueue("slow", {});
    const b = q.enqueue("slow", {});
    q.cancel(b.id);
    await q.drain();
    expect(b.status).toBe("cancelled");
    expect(a.status).toBe("completed");
  });

  it("aborts running jobs on cancel", async () => {
    const q = new JobQueue({ concurrency: 1, pollIntervalMs: 5 });
    let observedAbort = false;
    q.handle("long", async (_payload, signal) => {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, 500);
        signal.addEventListener("abort", () => {
          observedAbort = true;
          clearTimeout(t);
          reject(new DOMException("Aborted", "AbortError"));
        });
      });
    });
    const job = q.enqueue("long", {});
    await new Promise((r) => setTimeout(r, 10)); // let it start
    q.cancel(job.id);
    await q.drain();
    expect(observedAbort).toBe(true);
    expect(job.status).toBe("cancelled");
  });

  it("stop() aborts everything running", async () => {
    const q = new JobQueue({ concurrency: 2, pollIntervalMs: 5 });
    q.handle("long", async (_p, signal) => {
      await new Promise((resolve, reject) => {
        const t = setTimeout(resolve, 1000);
        signal.addEventListener("abort", () => {
          clearTimeout(t);
          reject(new DOMException("Aborted", "AbortError"));
        });
      });
    });
    q.enqueue("long", {});
    await new Promise((r) => setTimeout(r, 10));
    q.stop();
    await new Promise((r) => setTimeout(r, 20));
    const stats = q.stats();
    expect(stats.running).toBe(0);
  });

  it("reports queue statistics", async () => {
    const q = new JobQueue({ concurrency: 1, pollIntervalMs: 5 });
    q.handle("ok", async () => ({}));
    q.enqueue("ok", {});
    q.enqueue("ok", {});
    const stats = q.stats();
    expect(stats.pending + stats.running).toBe(2);
    expect(stats.total).toBe(2);
    await q.drain();
    expect(q.stats().pending).toBe(0);
  });
});
