import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AccountPoolManager } from "../lib/pool.js";
import { AntigravityPoolAdapter, generateImageThroughPool } from "../lib/index.js";

const SSE = (...lines) => lines.map((l) => `data: ${l}\n\n`).join("");

function textChunk(text) {
  return JSON.stringify({
    response: {
      candidates: [{ content: { parts: [{ text }] } }],
    },
  });
}

function sseResponse(body, status = 200) {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body));
      controller.close();
    },
  });
  return new Response(stream, { status, headers: { "content-type": "text/event-stream" } });
}

function errorResponse(status, text) {
  return new Response(text, { status, headers: { "content-type": "text/plain" } });
}

// Minimal in-memory model settings store: the adapter only ever calls read().
function modelSettings(overrides = {}) {
  return {
    async read() {
      return {
        catalogModels: [],
        enabledModelIds: [],
        ...overrides,
      };
    },
  };
}

async function createTempManager() {
  const dir = await mkdtemp(join(tmpdir(), "gemini-pool-adapter-"));
  const manager = new AccountPoolManager(join(dir, "accounts.json"), join(dir, "legacy.json"));
  await manager.init();
  return {
    manager,
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

async function addAccount(manager, email) {
  await manager.addOrUpdateAccount({
    email,
    refresh: `refresh_${email}`,
    access: `access_${email}`,
    expires: Date.now() + 3600_000,
    projectId: "test-project",
  });
  return (await manager.getStatus()).accounts.find((a) => a.email === email).id;
}

// Records every markCooldown call so a test can assert on call count.
function spyPool(manager) {
  const calls = [];
  const original = manager.markCooldown.bind(manager);
  manager.markCooldown = async (id, durationMs, reason) => {
    calls.push({ id, durationMs, reason });
    return original(id, durationMs, reason);
  };
  return calls;
}

async function withStubbedFetch(handler, run) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init, calls.length);
  };
  try {
    return await run(calls);
  } finally {
    globalThis.fetch = original;
  }
}

// The adapter performs model-discovery requests (fetchAvailableModels) before
// the streaming request, so fakes must route on the URL rather than on call
// order. Discovery is answered with an empty but valid payload.
function isStreamRequest(url) {
  return url.includes(":streamGenerateContent");
}

function isDiscoveryRequest(url) {
  return url.includes(":fetchAvailableModels");
}

function discoveryResponse() {
  return new Response(JSON.stringify({ models: {} }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

// C1-adjacent guard: a real successful stream must leave failureCount intact so
// the backoff ladder can still retire a flaky account.
test("successful stream clears cooldown window without resetting failureCount", async () => {
  const { manager, cleanup } = await createTempManager();
  try {
    const accountId = await addAccount(manager, "ok@example.com");
    await manager.updateConfig({ cooldownMs: 1000, disableThreshold: 3 });
    await manager.markCooldown(accountId, undefined, "earlier 429");
    assert.equal((await manager.getStatus()).accounts[0].failureCount, 1);

    const adapter = new AntigravityPoolAdapter(manager, modelSettings(), () => undefined);
    await withStubbedFetch(
      (url) => (isDiscoveryRequest(url) ? discoveryResponse() : sseResponse(SSE(textChunk("hello")))),
      async () => {
        const chunks = [];
        for await (const chunk of adapter.stream({
          model: "gemini-3.8-flash",
          messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        })) {
          chunks.push(chunk);
        }
        assert.ok(chunks.length > 0, "stream must yield chunks");
      },
    );

    const acc = (await manager.getStatus()).accounts[0];
    assert.equal(acc.failureCount, 1, "successful stream must not reset failureCount");
    assert.equal(acc.cooldownRemainingMs, 0, "successful stream must clear the cooldown window");
  } finally {
    await cleanup();
  }
});

// Important: quota-ish text in a 400 must not cool down the account on the
// image path. "quota field unknown" is a malformed request, not exhaustion.
test("image path does not mark cooldown for a 400 whose text merely contains quota", async () => {
  const { manager, cleanup } = await createTempManager();
  try {
    const accountId = await addAccount(manager, "img@example.com");
    await manager.updateConfig({ cooldownMs: 1000, disableThreshold: 5 });
    const calls = spyPool(manager);

    await withStubbedFetch(
      (url) =>
        isDiscoveryRequest(url)
          ? discoveryResponse()
          : errorResponse(400, "400 invalid request: quota field unknown"),
      async () => {
        await assert.rejects(
          () => generateImageThroughPool("draw a cat", manager, modelSettings()),
          /400|quota field unknown/i,
        );
      },
    );

    assert.equal(calls.length, 0, `markCooldown must not be called for a 400 (got ${JSON.stringify(calls)})`);
    const acc = (await manager.getStatus()).accounts[0];
    assert.equal(acc.failureCount, 0, "a 400 must not count as a cooldown failure");
    assert.equal(acc.status, "active");
    void accountId;
  } finally {
    await cleanup();
  }
});

// Critical: exhausting the pool is not an authentication failure. Users being
// told "AUTH" are pushed to re-login when they only need to wait or add accounts.
test("all accounts disabled yields a non-AUTH error code from stream()", async () => {
  const { manager, cleanup } = await createTempManager();
  try {
    const accountId = await addAccount(manager, "gone@example.com");
    await manager.updateConfig({ disableThreshold: 1 });
    await manager.markCooldown(accountId, undefined, "disabled");

    const adapter = new AntigravityPoolAdapter(manager, modelSettings(), () => undefined);
    await withStubbedFetch(
      (url) => (isDiscoveryRequest(url) ? discoveryResponse() : sseResponse(SSE(textChunk("unused")))),
      async () => {
        await assert.rejects(
          async () => {
            for await (const _chunk of adapter.stream({
              model: "gemini-3.8-flash",
              messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
            })) {
              void _chunk;
            }
          },
          (error) => {
            assert.equal(error.code, "EXHAUSTED", `all-disabled pool must surface as EXHAUSTED (got ${error.code})`);
            return true;
          },
        );
      },
    );
  } finally {
    await cleanup();
  }
});

// Important: a 429 arriving mid-stream after chunks were already emitted must
// still cool the account down. Failover is deliberately skipped (stream
// integrity), but the cooldown bookkeeping must happen.
test("mid-stream 429 after a chunk still marks cooldown but does not failover", async () => {
  const { manager, cleanup } = await createTempManager();
  try {
    const firstId = await addAccount(manager, "first@example.com");
    await addAccount(manager, "second@example.com");
    await manager.updateConfig({ cooldownMs: 1000, disableThreshold: 5 });
    const calls = spyPool(manager);

    // The stream request yields chunks, then surfaces a 429 in the same SSE
    // body. The adapter processes the text frame before the error frame, so
    // anyChunkYielded is already true when the 429 is classified.
    let streamRequests = 0;
    await withStubbedFetch(
      (url) => {
        if (isDiscoveryRequest(url)) return discoveryResponse();
        streamRequests += 1;
        const body = `${SSE(textChunk("partial"))}data: ${JSON.stringify({ error: { message: "429 RESOURCE_EXHAUSTED: Individual quota reached" } })}\n\n`;
        return sseResponse(body);
      },
      async () => {
        const adapter = new AntigravityPoolAdapter(manager, modelSettings(), () => undefined);
        let yielded = 0;
        await assert.rejects(async () => {
          for await (const _chunk of adapter.stream({
            model: "gemini-3.8-flash",
            messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
          })) {
            yielded += 1;
            void _chunk;
          }
        });
        assert.ok(yielded > 0, "test must produce at least one chunk before the 429");
      },
    );

    const first = (await manager.getStatus()).accounts.find((a) => a.id === firstId);
    assert.equal(calls.length, 1, `markCooldown must be called once for the mid-stream 429 (got ${calls.length})`);
    assert.equal(calls[0].id, firstId);
    assert.equal(first.failureCount, 1, "mid-stream 429 must accumulate a failure");
    assert.ok(first.cooldownRemainingMs > 0, "mid-stream 429 must open a cooldown window");
    assert.equal(streamRequests, 1, "must not fail over to the second account mid-stream");
  } finally {
    await cleanup();
  }
});
