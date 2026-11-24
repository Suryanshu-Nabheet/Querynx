import { describe, expect, it } from "vitest";
import { loadAppConfig } from "../src/index.js";

describe("loadAppConfig", () => {
  it("returns defaults for an empty environment", () => {
    const config = loadAppConfig({});
    expect(config.port).toBe(3001);
    expect(config.host).toBe("127.0.0.1");
    expect(config.apiKeys).toEqual([]);
    expect(config.queueBackend).toBe("memory");
    expect(config.embeddingsDimensions).toBe(384);
    expect(config.allowPrivateNetworks).toBe(false);
  });

  it("reads provider keys and detects enabled providers", () => {
    const config = loadAppConfig({
      BRAVE_API_KEY: "b",
      SEARXNG_BASE_URL: "http://s:8080",
    });
    expect(config.enabledProviders).toEqual(["searxng", "brave"]);
  });

  it("honors explicit provider lists over detection", () => {
    const config = loadAppConfig({
      QUERYNX_PROVIDERS: "brave",
      BRAVE_API_KEY: "b",
      TAVILY_API_KEY: "t",
    });
    expect(config.enabledProviders).toEqual(["brave"]);
  });

  it("parses csv api keys and numbers", () => {
    const config = loadAppConfig({
      QUERYNX_API_KEYS: "a, b ,c",
      PORT: "9999",
      PROVIDER_CONCURRENCY: "8",
      ANONYMOUS_RATE_LIMIT_PER_MIN: "120",
    });
    expect(config.apiKeys).toEqual(["a", "b", "c"]);
    expect(config.port).toBe(9999);
    expect(config.providerConcurrency).toBe(8);
    expect(config.anonymousRateLimitPerMinute).toBe(120);
  });

  it("uses redis queue backend only when a redis url exists", () => {
    expect(loadAppConfig({ QUEUE_BACKEND: "redis" }).queueBackend).toBe(
      "memory",
    );
    expect(
      loadAppConfig({ QUEUE_BACKEND: "redis", REDIS_URL: "redis://x" })
        .queueBackend,
    ).toBe("redis");
  });

  it("rejects invalid log levels", () => {
    expect(loadAppConfig({ LOG_LEVEL: "loud" }).logLevel).toBe("info");
    expect(loadAppConfig({ LOG_LEVEL: "debug" }).logLevel).toBe("debug");
  });

  it("falls back on malformed numbers", () => {
    const config = loadAppConfig({
      PORT: "not-a-number",
      PROVIDER_CONCURRENCY: "-5",
    });
    expect(config.port).toBe(3001);
    expect(config.providerConcurrency).toBe(4);
  });
});
