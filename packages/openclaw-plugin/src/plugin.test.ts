import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { DaemonClient } from "./client.js";
import { createContextEngine, resolveConfig } from "./plugin.js";
import type { ResolvedConfig } from "./types.js";

// --- Mock HTTP server ---

interface MockHandler {
  (req: http.IncomingMessage, res: http.ServerResponse): void;
}

function createMockServer(): {
  server: http.Server;
  start: () => Promise<number>;
  stop: () => Promise<void>;
  setHandler: (h: MockHandler) => void;
} {
  let handler: MockHandler = (_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ text: "", tokens: 0, nodesUsed: 0, layers: { user: 0, agent: 0, collaboration: 0 }, assemblyMs: 0 }));
  };

  const server = http.createServer((req, res) => handler(req, res));

  return {
    server,
    start: () =>
      new Promise<number>((resolve) => {
        server.listen(0, "127.0.0.1", () => {
          const addr = server.address() as { port: number };
          resolve(addr.port);
        });
      }),
    stop: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
    setHandler: (h: MockHandler) => {
      handler = h;
    },
  };
}

function makeConfig(port: number, overrides?: Partial<ResolvedConfig>): ResolvedConfig {
  return {
    daemonUrl: `http://127.0.0.1:${port}`,
    timeoutMs: 500,
    retryMs: 50,
    maxRetries: 1,
    ...overrides,
  };
}

function headerResponse(text: string) {
  return JSON.stringify({
    text,
    tokens: text.length / 4,
    nodesUsed: 3,
    layers: { user: 1, agent: 1, collaboration: 1 },
    assemblyMs: 5,
  });
}

// --- Client tests ---

describe("DaemonClient", () => {
  const mock = createMockServer();
  let port: number;

  before(async () => {
    port = await mock.start();
  });
  after(() => mock.stop());

  describe("fetchHeader", () => {
    it("returns header text on success", async () => {
      mock.setHandler((_req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(headerResponse("You are helping a developer with a React project."));
      });

      const client = new DaemonClient(makeConfig(port));
      const result = await client.fetchHeader("user: hello");
      assert.equal(result, "You are helping a developer with a React project.");
    });

    it("sends recent messages in POST body", async () => {
      let receivedBody = "";
      mock.setHandler((req, res) => {
        let data = "";
        req.on("data", (chunk) => (data += chunk));
        req.on("end", () => {
          receivedBody = data;
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(headerResponse("header"));
        });
      });

      const client = new DaemonClient(makeConfig(port));
      await client.fetchHeader("user: test message");

      const parsed = JSON.parse(receivedBody);
      assert.equal(parsed.recentMessages, "user: test message");
    });

    it("returns cached header on daemon error", async () => {
      // First call succeeds
      mock.setHandler((_req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(headerResponse("cached header text"));
      });
      const client = new DaemonClient(makeConfig(port, { maxRetries: 0 }));
      await client.fetchHeader();
      assert.equal(client.getCachedHeader(), "cached header text");

      // Second call fails — should return cached
      mock.setHandler((_req, res) => {
        res.writeHead(500);
        res.end("Internal Server Error");
      });
      const result = await client.fetchHeader();
      assert.equal(result, "cached header text");
    });

    it("returns empty string when no cache and daemon unreachable", async () => {
      const client = new DaemonClient(makeConfig(99999, { maxRetries: 0, timeoutMs: 50 }));
      const result = await client.fetchHeader();
      assert.equal(result, "");
    });

    it("handles timeout and returns cached or empty", async () => {
      mock.setHandler((_req, res) => {
        // Delay beyond timeout
        setTimeout(() => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(headerResponse("late response"));
        }, 300);
      });

      const client = new DaemonClient(makeConfig(port, { timeoutMs: 30, maxRetries: 0 }));
      const result = await client.fetchHeader();
      assert.equal(result, ""); // No cache, so empty
    });

    it("does not retry on failure (hot path)", async () => {
      let callCount = 0;
      mock.setHandler((_req, res) => {
        callCount++;
        if (callCount === 1) {
          res.writeHead(500);
          res.end("fail");
        } else {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(headerResponse("retry success"));
        }
      });

      const client = new DaemonClient(makeConfig(port, { maxRetries: 1, retryMs: 10 }));
      const result = await client.fetchHeader();
      // fetchHeader no longer retries (hot path), so first failure returns empty
      assert.equal(result, "");
      assert.equal(callCount, 1);
    });
  });

  describe("notifyTurn", () => {
    it("sends POST to /notify with sessionId", async () => {
      let receivedPath = "";
      let receivedBody = "";
      mock.setHandler((req, res) => {
        receivedPath = req.url ?? "";
        let data = "";
        req.on("data", (chunk) => (data += chunk));
        req.on("end", () => {
          receivedBody = data;
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        });
      });

      const client = new DaemonClient(makeConfig(port));
      client.notifyTurn("sess-123");

      // Give fire-and-forget time to complete
      await new Promise((r) => setTimeout(r, 100));

      assert.equal(receivedPath, "/notify");
      const parsed = JSON.parse(receivedBody);
      assert.equal(parsed.sessionId, "sess-123");
    });

    it("does not throw when daemon is unreachable", () => {
      const client = new DaemonClient(makeConfig(99999));
      // Should not throw
      client.notifyTurn("sess-456");
    });
  });
});

// --- Plugin tests ---

describe("Plugin: createContextEngine", () => {
  const mock = createMockServer();
  let port: number;

  before(async () => {
    port = await mock.start();
  });
  after(() => mock.stop());

  describe("info", () => {
    it("has correct id and ownsCompaction=false", () => {
      const engine = createContextEngine(makeConfig(port));
      assert.equal(engine.info.id, "memrok");
      assert.equal(engine.info.name, "Memrok Memory Layer");
      assert.equal(engine.info.ownsCompaction, false);
    });
  });

  describe("assemble", () => {
    it("returns messages unchanged with systemPromptAddition", async () => {
      mock.setHandler((_req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(headerResponse("Memory context: user prefers TypeScript"));
      });

      const engine = createContextEngine(makeConfig(port));
      const messages = [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi there" },
      ];

      const result = await engine.assemble({
        sessionId: "s1",
        messages,
        tokenBudget: 8000,
      });

      // Messages passed through unchanged
      assert.deepEqual(result.messages, messages);
      assert.equal(result.systemPromptAddition, "Memory context: user prefers TypeScript");
      assert.ok(result.estimatedTokens > 0);
    });

    it("returns empty systemPromptAddition when daemon is down", async () => {
      const engine = createContextEngine(makeConfig(99999, { timeoutMs: 30, maxRetries: 0 }));
      const messages = [{ role: "user", content: "test" }];

      const result = await engine.assemble({
        sessionId: "s2",
        messages,
        tokenBudget: 8000,
      });

      // Messages still returned
      assert.deepEqual(result.messages, messages);
      // No systemPromptAddition (empty string becomes undefined)
      assert.equal(result.systemPromptAddition, undefined);
    });

    it("never throws even with malformed daemon response", async () => {
      mock.setHandler((_req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end("not json at all{{{");
      });

      const engine = createContextEngine(makeConfig(port, { maxRetries: 0 }));
      const messages = [{ role: "user", content: "x" }];

      // Must not throw
      const result = await engine.assemble({
        sessionId: "s3",
        messages,
        tokenBudget: 4000,
      });

      assert.deepEqual(result.messages, messages);
    });

    it("estimates tokens from message content", async () => {
      mock.setHandler((_req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(headerResponse("h"));
      });

      const engine = createContextEngine(makeConfig(port));
      const messages = [{ role: "user", content: "a".repeat(400) }];

      const result = await engine.assemble({
        sessionId: "s4",
        messages,
        tokenBudget: 8000,
      });

      assert.equal(result.estimatedTokens, 100); // 400 / 4
    });
  });

  describe("ingest", () => {
    it("returns ingested: true (no-op)", async () => {
      const engine = createContextEngine(makeConfig(port));
      const result = await engine.ingest({
        sessionId: "s1",
        message: { role: "user", content: "hi" },
      });
      assert.deepEqual(result, { ingested: true });
    });
  });

  describe("compact", () => {
    it("returns fallback when openclaw SDK is not available", async () => {
      const engine = createContextEngine(makeConfig(port));
      const result = await engine.compact({ sessionId: "s1" });
      assert.deepEqual(result, { ok: true, compacted: false });
    });
  });

  describe("afterTurn", () => {
    it("calls notify without blocking", async () => {
      let notified = false;
      mock.setHandler((req, res) => {
        if (req.url === "/notify") notified = true;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });

      const engine = createContextEngine(makeConfig(port));
      await engine.afterTurn({ sessionId: "s1" });

      // Give fire-and-forget time
      await new Promise((r) => setTimeout(r, 100));
      assert.equal(notified, true);
    });
  });
});

// --- resolveConfig tests ---

describe("resolveConfig", () => {
  it("uses defaults when no config provided", () => {
    const config = resolveConfig();
    assert.equal(config.daemonUrl, "http://127.0.0.1:18790");
    assert.equal(config.timeoutMs, 50);
    assert.equal(config.retryMs, 200);
    assert.equal(config.maxRetries, 1);
  });

  it("overrides individual values", () => {
    const config = resolveConfig({ daemonUrl: "http://localhost:9999", timeoutMs: 100 });
    assert.equal(config.daemonUrl, "http://localhost:9999");
    assert.equal(config.timeoutMs, 100);
    assert.equal(config.retryMs, 200); // default
  });
});

// --- register tests ---

describe("register", () => {
  it("registers a context engine with the plugin API", async () => {
    const { default: register } = await import("./plugin.js");
    let registeredId = "";
    let registeredFactory: (() => unknown) | null = null;

    const mockApi = {
      registerContextEngine(id: string, factory: () => unknown) {
        registeredId = id;
        registeredFactory = factory;
      },
    };

    register(mockApi, { daemonUrl: "http://127.0.0.1:1234" });

    assert.equal(registeredId, "memrok");
    assert.ok(registeredFactory);

    const engine = registeredFactory!() as { info: { id: string } };
    assert.equal(engine.info.id, "memrok");
  });
});
