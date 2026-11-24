import { describe, expect, it } from "vitest";
import {
  isPublicIpv4,
  isPublicIpv6,
  isPublicIp,
  setPrivateNetworkPolicy,
  validatingLookup,
} from "../src/dns.js";
import { fetchUrl } from "../src/fetcher.js";

describe("isPublicIpv4", () => {
  it("accepts public addresses", () => {
    for (const ip of [
      "8.8.8.8",
      "1.1.1.1",
      "93.184.216.34",
      "172.32.0.1",
      "172.15.0.1",
    ]) {
      expect(isPublicIpv4(ip)).toBe(true);
    }
  });

  it("rejects private, loopback and reserved ranges", () => {
    for (const ip of [
      "127.0.0.1",
      "10.0.0.1",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "0.0.0.0",
      "224.0.0.1",
      "255.255.255.255",
      "198.18.0.1",
    ]) {
      expect(isPublicIpv4(ip)).toBe(false);
    }
  });
});

describe("isPublicIpv6", () => {
  it("accepts public addresses", () => {
    expect(isPublicIpv6("2606:4700:4700::1111")).toBe(true);
    expect(isPublicIpv6("2001:db8::1")).toBe(true);
  });

  it("rejects loopback, link-local and unique-local", () => {
    expect(isPublicIpv6("::1")).toBe(false);
    expect(isPublicIpv6("::")).toBe(false);
    expect(isPublicIpv6("fe80::1")).toBe(false);
    expect(isPublicIpv6("fc00::1")).toBe(false);
    expect(isPublicIpv6("fd12:3456::1")).toBe(false);
  });

  it("validates IPv4-mapped and compatible forms", () => {
    expect(isPublicIpv6("::ffff:169.254.169.254")).toBe(false);
    expect(isPublicIpv6("::ffff:8.8.8.8")).toBe(true);
    expect(isPublicIpv6("::10.0.0.1")).toBe(false);
    expect(isPublicIpv6("::8.8.8.8")).toBe(true);
  });
});

describe("validatingLookup", () => {
  it("resolves public hostnames (single-form callback)", async () => {
    const result = await new Promise<{
      err: Error | null;
      address: string | Array<{ address: string; family: number }>;
    }>((resolve) => {
      validatingLookup("example.com", {}, (err, address) =>
        resolve({ err: err ?? null, address }),
      );
    });
    expect(result.err).toBeNull();
    // Single-form contract: a bare address string.
    expect(typeof result.address).toBe("string");
    expect(isPublicIp(result.address as string)).toBe(true);
  }, 15_000);

  it("refuses hostnames resolving to private space", async () => {
    const result = await new Promise<{
      err: Error | null;
      address: string | Array<{ address: string; family: number }>;
    }>((resolve) => {
      validatingLookup("localhost", {}, (err, address) =>
        resolve({ err: err ?? null, address }),
      );
    });
    expect(result.err).not.toBeNull();
    expect(result.err!.message).toContain("non-public");
  });

  it("resolves private hostnames when the operator policy allows it", async () => {
    const previous = setPrivateNetworkPolicy(true);
    try {
      const result = await new Promise<{
        err: Error | null;
        address: string | Array<{ address: string; family: number }>;
      }>((resolve) => {
        validatingLookup("localhost", {}, (err, address) =>
          resolve({ err: err ?? null, address }),
        );
      });
      expect(result.err).toBeNull();
      expect(typeof result.address).toBe("string");
      expect(["127.0.0.1", "::1"]).toContain(result.address as string);
    } finally {
      setPrivateNetworkPolicy(previous);
    }
  });

  it("refuses metadata endpoints", async () => {
    const result = await new Promise<{ err: Error | null }>((resolve) => {
      validatingLookup("metadata.google.internal", {}, (err) =>
        resolve({ err: err ?? null }),
      );
    });
    expect(result.err).not.toBeNull();
  }, 15_000);
});

describe("validatingLookup callback contract", () => {
  it("serves the all-form callback when all:true (undici's call shape)", async () => {
    const result = await new Promise<{
      err: Error | null;
      list?: Array<{ address: string; family: number }>;
    }>((resolve) => {
      validatingLookup("example.com", { all: true, hints: 1024 }, (err, list) =>
        resolve({ err: err ?? null, list: list as never }),
      );
    });
    // Real DNS: example.com must resolve to public addresses here.
    if (result.err === null) {
      expect(Array.isArray(result.list)).toBe(true);
      expect(result.list!.length).toBeGreaterThan(0);
      for (const entry of result.list!) {
        expect(isPublicIp(entry.address)).toBe(true);
      }
    } else {
      // Offline environments: the call must still fail cleanly.
      expect(result.list).toEqual([]);
    }
  }, 20_000);

  it("serves the single-form callback without all:true (net.connect shape)", async () => {
    const result = await new Promise<{
      err: Error | null;
      address: string | Array<{ address: string; family: number }>;
    }>((resolve) => {
      validatingLookup("example.com", {}, (err, address) =>
        resolve({ err: err ?? null, address }),
      );
    });
    if (typeof result.address !== "string")
      throw new Error("expected single-form");
    if (result.err === null) {
      expect(isPublicIp(result.address)).toBe(true);
    }
  }, 20_000);

  it("all-form rejects hostnames resolving only to private space", async () => {
    const result = await new Promise<{
      err: Error | null;
      list?: unknown;
    }>((resolve) => {
      validatingLookup("localhost", { all: true }, (err, list) =>
        resolve({ err: err ?? null, list }),
      );
    });
    expect(result.err).not.toBeNull();
    expect(result.err!.message).toContain("non-public");
    expect(result.list).toEqual([]);
  });
});

describe("hostname fetch regression (the all-form bug)", () => {
  it("fetches a real hostname through the shared validating agent", async () => {
    // This is the exact path that returned "Invalid IP address:
    // undefined" on every real-network fetch before the contract fix.
    // example.com is IANA-reserved documentation domain — safe target.
    try {
      const result = await fetchUrl("https://example.com/", {
        timeoutMs: 15_000,
      });
      expect(result.statusCode).toBe(200);
      expect(result.body).toContain("Example Domain");
    } catch (err) {
      // Offline CI: DNS resolution may genuinely fail — but it must
      // NEVER fail with the contract bug's signature.
      const message = err instanceof Error ? err.message : String(err);
      expect(message).not.toContain("Invalid IP address");
    }
  }, 30_000);
});
