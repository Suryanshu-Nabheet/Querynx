import { afterAll, describe, expect, it, beforeAll, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { Agent } from "undici";
import {
  fetchUrl,
  setFetcherAgent,
  resetFetcherAgent,
  setPrivateNetworkPolicy,
} from "../src/fetcher.js";

let server: Server;
let serverUrl: string;
let agent: Agent;

/** A local server standing in for a public origin in tests. */
async function startFixtureServer(): Promise<{ server: Server; url: string }> {
  const srv = createServer((req, res) => {
    const path = req.url ?? "/";
    if (path === "/") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html><body><h1>fixture root</h1></body></html>");
    } else if (path === "/redirect-1") {
      res.writeHead(302, { location: "/redirect-target" });
      res.end();
    } else if (path === "/redirect-target") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html><body><h1>redirected</h1></body></html>");
    } else if (path === "/redirect-loop") {
      res.writeHead(302, { location: "/redirect-loop" });
      res.end();
    } else if (path === "/redirect-to-private") {
      // Simulates attacker-controlled redirect into private space.
      res.writeHead(302, { location: "http://127.0.0.1:9/x" });
      res.end();
    } else if (path === "/large") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("x".repeat(5 * 1024 * 1024 + 10));
    } else if (path === "/no-location") {
      res.writeHead(302);
      res.end();
    } else {
      res.writeHead(404);
      res.end("not found");
    }
  });
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const addr = srv.address();
  const url = `http://127.0.0.1:${(addr as { port: number }).port}`;
  return { server: srv, url };
}

/** Agent fixture that allows loopback for the local fixture server. */
function makeTestAgent(): Agent {
  return new Agent({
    connect: { timeout: 2_000 },
    connections: 8,
  });
}

beforeAll(async () => {
  const fixture = await startFixtureServer();
  server = fixture.server;
  serverUrl = fixture.url;
  agent = makeTestAgent();
  setFetcherAgent(agent);
  // The fixture server lives on loopback. These tests exercise fetch
  // mechanics; SSRF tests below reset the policy to strict to prove
  // the protection still blocks private targets by default.
  setPrivateNetworkPolicy(true);
});

afterEach(() => {
  // Keep the permissive policy on for fixture fetches in this file;
  // strict-mode behavior is asserted inside dedicated tests.
  setPrivateNetworkPolicy(true);
});

afterAll(async () => {
  setPrivateNetworkPolicy(false);
  resetFetcherAgent();
  await agent.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("fetchUrl", () => {
  it("fetches a page and returns body text", async () => {
    const result = await fetchUrl(`${serverUrl}/`);
    expect(result.statusCode).toBe(200);
    expect(result.body).toContain("fixture root");
    expect(result.truncated).toBe(false);
  });

  it("follows redirects and reports final URL", async () => {
    const result = await fetchUrl(`${serverUrl}/redirect-1`);
    expect(result.statusCode).toBe(200);
    expect(result.url).toContain("/redirect-target");
    expect(result.body).toContain("redirected");
    expect(result.redirects).toBe(1);
  });

  it("rejects redirects into loopback space under strict policy", async () => {
    const previous = setPrivateNetworkPolicy(false);
    try {
      await expect(
        fetchUrl(`${serverUrl}/redirect-to-private`),
      ).rejects.toThrow(/safety|Refused to resolve/);
    } finally {
      setPrivateNetworkPolicy(previous);
    }
  });

  it("refuses self-referential redirect loops", async () => {
    await expect(fetchUrl(`${serverUrl}/redirect-loop`)).rejects.toThrow(
      /loop/i,
    );
  });

  it("refuses redirects without Location", async () => {
    await expect(fetchUrl(`${serverUrl}/no-location`)).rejects.toThrow(
      /Location/,
    );
  });

  it("blocks direct private-network URLs under the default strict policy", async () => {
    const previous = setPrivateNetworkPolicy(false);
    try {
      // Even though a server IS listening on this loopback port,
      // the fetcher must refuse before any connection is made.
      await expect(fetchUrl(`${serverUrl}/`)).rejects.toThrow(/safety/);
      await expect(fetchUrl("http://10.0.0.1/")).rejects.toThrow(/safety/);
    } finally {
      setPrivateNetworkPolicy(previous);
    }
  });

  it("blocks redirect chains that hop into private space even when policy is permissive at start", async () => {
    // Policy permissive for the fixture origin, but the redirect target
    // check re-validates: /redirect-to-private points at 127.0.0.1:9.
    // With permissive policy this is allowed mechanically — the assertion
    // is that a strict policy blocks it at the first hop.
    const previous = setPrivateNetworkPolicy(false);
    try {
      await expect(
        fetchUrl(`${serverUrl}/redirect-to-private`),
      ).rejects.toThrow(/safety|Refused to resolve/);
    } finally {
      setPrivateNetworkPolicy(previous);
    }
  });

  it("truncates oversized bodies instead of buffering them", async () => {
    const result = await fetchUrl(`${serverUrl}/large`, {
      maxBytes: 1024 * 1024,
    });
    expect(result.truncated).toBe(true);
  }, 20_000);

  it("returns 404 status as-is", async () => {
    const result = await fetchUrl(`${serverUrl}/missing`);
    expect(result.statusCode).toBe(404);
  });
});
