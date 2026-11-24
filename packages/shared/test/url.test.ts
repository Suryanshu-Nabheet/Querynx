import { describe, expect, it } from "vitest";
import {
  canonicalizeUrl,
  extractDomain,
  isPrivateIpv4,
  isSafeOutboundUrl,
  normalizeDomainFilter,
  passesDomainFilters,
} from "../src/url.js";

describe("canonicalizeUrl", () => {
  it("strips tracking params and fragments", () => {
    expect(
      canonicalizeUrl("https://example.com/page?utm_source=twitter&id=3#top"),
    ).toBe("https://example.com/page?id=3");
  });

  it("lowercases host and strips default port", () => {
    expect(canonicalizeUrl("HTTP://Example.COM:80/a")).toBe(
      "http://example.com/a",
    );
    expect(canonicalizeUrl("https://example.com:443/a")).toBe(
      "https://example.com/a",
    );
  });

  it("removes trailing slash except root", () => {
    expect(canonicalizeUrl("https://example.com/a/")).toBe(
      "https://example.com/a",
    );
    // Per WHATWG URL serialization, the root path serializes as "/".
    expect(canonicalizeUrl("https://example.com/")).toBe(
      "https://example.com/",
    );
  });

  it("rejects non-http schemes and relative input", () => {
    expect(canonicalizeUrl("ftp://example.com")).toBeNull();
    expect(canonicalizeUrl("/relative/path")).toBeNull();
    expect(canonicalizeUrl("javascript:alert(1)")).toBeNull();
  });
});

describe("isSafeOutboundUrl", () => {
  it("allows normal public http(s) URLs", () => {
    expect(isSafeOutboundUrl("https://example.com/doc")).toBe(true);
    expect(isSafeOutboundUrl("http://example.com")).toBe(true);
  });

  it("blocks loopback, local and internal hosts", () => {
    expect(isSafeOutboundUrl("http://localhost:3000/admin")).toBe(false);
    expect(isSafeOutboundUrl("http://127.0.0.1:8080/")).toBe(false);
    expect(isSafeOutboundUrl("http://10.0.0.5/")).toBe(false);
    expect(isSafeOutboundUrl("http://192.168.1.1/router")).toBe(false);
    expect(isSafeOutboundUrl("http://169.254.169.254/latest/meta-data")).toBe(
      false,
    );
    expect(isSafeOutboundUrl("http://metadata.google.internal/")).toBe(false);
    expect(isSafeOutboundUrl("http://service.internal/api")).toBe(false);
  });

  it("blocks non-http schemes", () => {
    expect(isSafeOutboundUrl("file:///etc/passwd")).toBe(false);
    expect(isSafeOutboundUrl("gopher://example.com")).toBe(false);
  });
});

describe("isPrivateIpv4", () => {
  it("classifies RFC1918 and special ranges", () => {
    expect(isPrivateIpv4("10.1.2.3")).toBe(true);
    expect(isPrivateIpv4("172.16.0.1")).toBe(true);
    expect(isPrivateIpv4("172.32.0.1")).toBe(false);
    expect(isPrivateIpv4("192.168.0.1")).toBe(true);
    expect(isPrivateIpv4("169.254.1.1")).toBe(true);
    expect(isPrivateIpv4("8.8.8.8")).toBe(false);
    expect(isPrivateIpv4("not-an-ip")).toBe(false);
  });
});

describe("passesDomainFilters", () => {
  it("honors include lists with subdomains", () => {
    expect(
      passesDomainFilters("https://docs.python.org/3/", ["python.org"]),
    ).toBe(true);
    expect(passesDomainFilters("https://example.com/", ["python.org"])).toBe(
      false,
    );
  });

  it("honors exclude lists", () => {
    expect(
      passesDomainFilters("https://spam.example.com/", undefined, [
        "example.com",
      ]),
    ).toBe(false);
    expect(
      passesDomainFilters("https://good.org/", undefined, ["example.com"]),
    ).toBe(true);
  });

  it("passes when no filters provided", () => {
    expect(passesDomainFilters("https://anything.example/")).toBe(true);
  });

  it("accepts wildcard and www-prefixed filters", () => {
    expect(normalizeDomainFilter("*.example.com")).toBe("example.com");
    expect(normalizeDomainFilter("https://www.example.com/")).toBe(
      "example.com",
    );
  });
});
