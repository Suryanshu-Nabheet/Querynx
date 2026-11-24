import { describe, expect, it } from "vitest";
import { RobotsFile, matchesPath } from "../src/robots.js";

const SAMPLE = `# robots.txt
User-agent: *
Disallow: /admin
Disallow: /private/
Allow: /private/allowed
Crawl-delay: 2

User-agent: QuerynxBot
Disallow: /search
Allow: /search/help

User-agent: *
Disallow: /everything

Sitemap: https://example.com/sitemap.xml
`;

describe("RobotsFile", () => {
  const robots = new RobotsFile(SAMPLE);

  it("applies wildcard rules to unknown agents", () => {
    expect(robots.isAllowed("https://example.com/page", "OtherBot")).toBe(true);
    expect(
      robots.isAllowed("https://example.com/admin/panel", "OtherBot"),
    ).toBe(false);
  });

  it("prefers exact agent group over wildcard", () => {
    // QuerynxBot matches its own group exclusively; the * group's
    // /admin rule does NOT apply to it (REP: specific match replaces *).
    expect(
      robots.isAllowed("https://example.com/search?q=x", "querynxbot"),
    ).toBe(false);
    expect(
      robots.isAllowed("https://example.com/search/help", "querynxbot"),
    ).toBe(true);
    expect(robots.isAllowed("https://example.com/admin", "querynxbot")).toBe(
      true,
    );
  });

  it("longest Allow beats shorter Disallow", () => {
    const r = new RobotsFile(
      "User-agent: *\nDisallow: /private\nAllow: /private/allowed\n",
    );
    expect(r.isAllowed("https://example.com/private/allowed/page", "bot")).toBe(
      true,
    );
    expect(r.isAllowed("https://example.com/private/other", "bot")).toBe(false);
  });

  it("parses crawl-delay per group", () => {
    expect(robots.crawlDelayMs("OtherBot")).toBe(2000);
    expect(robots.crawlDelayMs("querynxbot")).toBeUndefined();
  });

  it("collects sitemaps", () => {
    expect(robots.sitemaps).toEqual(["https://example.com/sitemap.xml"]);
  });

  it("treats empty rules as allow-all", () => {
    const r = new RobotsFile("User-agent: *\n");
    expect(r.isAllowed("https://example.com/anything", "bot")).toBe(true);
  });

  it("handles multi-agent groups", () => {
    const r = new RobotsFile("User-agent: a\nUser-agent: b\nDisallow: /\n");
    expect(r.isAllowed("https://example.com/", "a")).toBe(false);
    expect(r.isAllowed("https://example.com/", "b")).toBe(false);
    expect(r.isAllowed("https://example.com/", "c")).toBe(true);
  });

  it("uses the first wildcard group when several exist at equal specificity", () => {
    // REP ambiguity: multiple * groups. First in file order wins, so the
    // second group's /everything rule never applies.
    expect(
      robots.isAllowed("https://example.com/everything/x", "OtherBot"),
    ).toBe(true);
  });
});

describe("matchesPath", () => {
  it("prefix matching without wildcards", () => {
    expect(matchesPath("/admin/login", "/admin")).toBe(true);
    expect(matchesPath("/administrator", "/admin")).toBe(true);
    expect(matchesPath("/public", "/admin")).toBe(false);
  });

  it("wildcards match any run", () => {
    expect(matchesPath("/a/b/c/d", "/a/*/d")).toBe(true);
    expect(matchesPath("/a/x/y/d", "/a/*/d")).toBe(true);
    expect(matchesPath("/a/d", "/a/*/d")).toBe(false);
  });

  it("dollar anchors to end", () => {
    expect(matchesPath("/page.html", "/page.html$")).toBe(true);
    expect(matchesPath("/page.html?x=1", "/page.html$")).toBe(false);
  });

  it("empty pattern allows everything", () => {
    expect(matchesPath("/anything", "")).toBe(true);
  });
});
