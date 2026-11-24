import { describe, expect, it } from "vitest";
import {
  isPublicIpv4,
  isPublicIpv6,
  isPublicIp,
  setPrivateNetworkPolicy,
  validatingLookup,
} from "../src/dns.js";

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
  it("resolves public hostnames", async () => {
    const result = await new Promise<{ err: Error | null; address: string }>(
      (resolve) => {
        validatingLookup("example.com", {}, (err, address) =>
          resolve({ err: err ?? null, address }),
        );
      },
    );
    expect(result.err).toBeNull();
    expect(isPublicIp(result.address)).toBe(true);
  }, 15_000);

  it("refuses hostnames resolving to private space", async () => {
    const result = await new Promise<{ err: Error | null; address: string }>(
      (resolve) => {
        validatingLookup("localhost", {}, (err, address) =>
          resolve({ err: err ?? null, address }),
        );
      },
    );
    expect(result.err).not.toBeNull();
    expect(result.err!.message).toContain("non-public");
  });

  it("resolves private hostnames when the operator policy allows it", async () => {
    const previous = setPrivateNetworkPolicy(true);
    try {
      const result = await new Promise<{ err: Error | null; address: string }>(
        (resolve) => {
          validatingLookup("localhost", {}, (err, address) =>
            resolve({ err: err ?? null, address }),
          );
        },
      );
      expect(result.err).toBeNull();
      expect(["127.0.0.1", "::1"]).toContain(result.address);
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
