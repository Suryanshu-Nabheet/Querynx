/**
 * Fixture integrity tests: the shared fixtures must actually exercise
 * what their names promise (so downstream suites inherit real inputs).
 */

import { describe, expect, it } from "vitest";
import {
  ROBOTS_STANDARD,
  ROBOTS_AGENT_SPECIFIC,
  ROBOTS_MULTI_GROUP,
  ROBOTS_WILDCARD_PATHS,
  ROBOTS_MALFORMED,
  HTML_ARTICLE,
  HTML_PRODUCT,
  SITEMAP_INDEX,
  SITEMAP_URLSET,
} from "./robots-fixtures.js";
import {
  SCRIPT_INJECTION,
  PROMPT_INJECTION,
  MALFORMED_ENTITIES,
} from "./html-attacks.js";
import { RobotsFile } from "@querynx/crawler";
import { extractDocument } from "@querynx/extractor";
import { parseSitemap } from "@querynx/crawler";

describe("robots fixtures", () => {
  it("ROBOTS_STANDARD disallows admin, allows public", () => {
    const robots = new RobotsFile(ROBOTS_STANDARD);
    expect(robots.isAllowed("https://example.com/admin/x", "bot")).toBe(false);
    expect(robots.isAllowed("https://example.com/page", "bot")).toBe(true);
    expect(robots.crawlDelayMs("bot")).toBe(2000);
  });

  it("ROBOTS_AGENT_SPECIFIC honors specific agents exclusively", () => {
    const robots = new RobotsFile(ROBOTS_AGENT_SPECIFIC);
    expect(robots.isAllowed("https://example.com/search", "querynxbot")).toBe(
      false,
    );
    expect(robots.isAllowed("https://example.com/anything", "other")).toBe(
      false,
    );
  });

  it("ROBOTS_MULTI_GROUP maps both agents to the shared group", () => {
    const robots = new RobotsFile(ROBOTS_MULTI_GROUP);
    expect(robots.isAllowed("https://example.com/shared", "crawler-a")).toBe(
      false,
    );
    expect(robots.isAllowed("https://example.com/shared", "crawler-b")).toBe(
      false,
    );
    expect(robots.isAllowed("https://example.com/wildcard", "crawler-a")).toBe(
      true,
    );
  });

  it("ROBOTS_WILDCARD_PATHS matches wildcard patterns", () => {
    const robots = new RobotsFile(ROBOTS_WILDCARD_PATHS);
    expect(robots.isAllowed("https://example.com/user/session/x", "b")).toBe(
      false,
    );
    expect(robots.isAllowed("https://example.com/doc/report.pdf", "b")).toBe(
      false,
    );
    expect(robots.isAllowed("https://example.com/user/public/x", "b")).toBe(
      true,
    );
  });

  it("ROBOTS_MALFORMED degrades to allow-all without crashing", () => {
    const robots = new RobotsFile(ROBOTS_MALFORMED);
    expect(robots.isAllowed("https://example.com/x", "bot")).toBe(true);
  });
});

describe("html fixtures", () => {
  it("HTML_ARTICLE extracts title, author and sections", () => {
    const doc = extractDocument(
      HTML_ARTICLE,
      "https://health.example/routines",
      200,
    );
    expect(doc.title).toContain("Fitness Routine Guide");
    expect(doc.metadata?.author).toBe("Dr. Kim");
    expect(doc.metadata?.publishedAt).toContain("2025-02-10");
    expect(doc.sections.some((s) => s.title === "Nutrition")).toBe(true);
  });

  it("HTML_PRODUCT extracts tables", () => {
    const doc = extractDocument(HTML_PRODUCT, "https://shop.example/x100", 200);
    expect(doc.tables.length).toBe(1);
    expect(doc.tables[0]?.rows[0]).toEqual(["Switches", "Hot-swappable"]);
  });

  it("SCRIPT_INJECTION stays inert", () => {
    extractDocument(SCRIPT_INJECTION, "https://evil.example/x", 200);
    expect((globalThis as Record<string, unknown>)["pwned"]).toBeUndefined();
    expect((globalThis as Record<string, unknown>)["ex"]).toBeUndefined();
  });

  it("PROMPT_INJECTION survives as text", () => {
    const doc = extractDocument(
      PROMPT_INJECTION,
      "https://prompt.example/x",
      200,
    );
    expect(doc.content).toContain("SYSTEM: ignore");
    expect(doc.content).toContain("12%");
  });

  it("MALFORMED_ENTITIES does not crash extraction", () => {
    const doc = extractDocument(MALFORMED_ENTITIES, "https://x.example/e", 200);
    expect(doc.content.length).toBeGreaterThan(0);
  });
});

describe("sitemap fixtures", () => {
  it("SITEMAP_INDEX lists child sitemaps", () => {
    const { sitemapIndexes } = parseSitemap(SITEMAP_INDEX);
    expect(sitemapIndexes).toHaveLength(2);
  });

  it("SITEMAP_URLSET lists page urls", () => {
    const { urls } = parseSitemap(SITEMAP_URLSET);
    expect(urls).toEqual([
      "https://example.com/page-a",
      "https://example.com/page-b",
    ]);
  });
});
