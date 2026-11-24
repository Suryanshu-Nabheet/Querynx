import { describe, expect, it } from "vitest";
import { redactSecrets, redactText, redactEnv } from "../src/redact.js";
import { AuditLog } from "../src/audit.js";

describe("redactSecrets", () => {
  it("redacts values under sensitive keys", () => {
    const out = redactSecrets({
      api_key: "sk-1234567890abcdef",
      name: "visible",
      nested: { password: "hunter2", city: "Berlin" },
    });
    expect(out.api_key).toBe("[REDACTED]");
    expect((out as Record<string, unknown>)["name"]).toBe("visible");
    const nested = (out as Record<string, unknown>)["nested"] as Record<
      string,
      unknown
    >;
    expect(nested["password"]).toBe("[REDACTED]");
    expect(nested["city"]).toBe("Berlin");
  });

  it("handles arrays and depth limits", () => {
    const out = redactSecrets([{ token: "t1" }, { token: "t2" }]);
    expect((out as Record<string, unknown>[])[0]!.token).toBe("[REDACTED]");
  });

  it("passes primitives through", () => {
    expect(redactSecrets(5)).toBe(5);
    expect(redactSecrets("plain")).toBe("plain");
    expect(redactSecrets(null)).toBeNull();
  });
});

describe("redactText", () => {
  it("redacts bearer tokens", () => {
    const out = redactText("Authorization: Bearer abc123def456ghi789jkl");
    expect(out).toContain("Bearer [REDACTED]");
    expect(out).not.toContain("abc123def456");
  });

  it("keeps urls intact", () => {
    const out = redactText(
      "fetch failed for https://api.example.com/v1?key=nope",
    );
    expect(out).toContain("api.example.com");
  });

  it("redacts KEY=value assignments", () => {
    const out = redactText("BRAVE_API_KEY=supersecretvalue LOG_LEVEL=info");
    expect(out).toContain("BRAVE_API_KEY=[REDACTED]");
    expect(out).toContain("LOG_LEVEL=info");
  });
});

describe("redactEnv", () => {
  it("redacts credential env vars only", () => {
    const out = redactEnv({ API_KEY: "x", PORT: "3001" });
    expect(out["API_KEY"]).toBe("[REDACTED]");
    expect(out["PORT"]).toBe("3001");
  });
});

describe("AuditLog", () => {
  it("records redacted events in order", () => {
    const log = new AuditLog();
    log.record("key.use", "key:abc", "allowed", { route: "/v1/search" });
    log.record("key.denied", "ip:1.2.3.4", "denied", {
      reason: "invalid key",
      api_key: "leaky",
    });
    const recent = log.recent();
    expect(recent).toHaveLength(2);
    expect(recent[0]!.type).toBe("key.use");
    expect(recent[1]!.outcome).toBe("denied");
    expect(recent[1]!.details["api_key"]).toBe("[REDACTED]");
  });

  it("caps retained events", () => {
    const log = new AuditLog({ maxEvents: 5 });
    for (let i = 0; i < 10; i++) log.record(`t${i}`, "a", "allowed");
    expect(log.size).toBe(5);
    expect(log.recent()[0]!.type).toBe("t5");
  });

  it("supports a sink for external transport", () => {
    const seen: string[] = [];
    const log = new AuditLog({ sink: (e) => seen.push(e.type) });
    log.record("x", "a", "allowed");
    expect(seen).toEqual(["x"]);
  });

  it("filters by outcome", () => {
    const log = new AuditLog();
    log.record("a", "x", "allowed");
    log.record("b", "x", "denied");
    log.record("c", "x", "denied");
    expect(log.byOutcome("denied")).toHaveLength(2);
  });
});
