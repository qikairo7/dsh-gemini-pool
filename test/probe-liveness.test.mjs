import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AccountPoolManager } from "../lib/pool.js";
import { probeAccountLiveness } from "../lib/index.js";

async function createTempManager() {
  const dir = await mkdtemp(join(tmpdir(), "gemini-pool-probe-"));
  const manager = new AccountPoolManager(join(dir, "accounts.json"), join(dir, "legacy.json"));
  await manager.init();
  await manager.addOrUpdateAccount({
    email: "probe@example.com",
    refresh: "dummy_refresh",
    access: "dummy_access",
    expires: Date.now() + 3600_000,
    projectId: "test-project",
  });
  return {
    manager,
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

function modelSettings(overrides = {}) {
  return {
    async read() {
      return { catalogModels: [], enabledModelIds: [], ...overrides };
    },
  };
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

function isDiscoveryRequest(url) {
  return url.includes(":fetchAvailableModels");
}

function discoveryResponse() {
  return new Response(JSON.stringify({ models: {} }), {
    status: 200,
    headers: { "content-type": "application/json" },
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

// C2: the probe must exercise the same streaming endpoint real traffic uses,
// not the quota-metadata endpoint (which can keep succeeding while the account
// is actually rate limited on generation).
test("probeAccountLiveness targets streamGenerateContent with a 1-token minimal prompt", async () => {
  const { manager, cleanup } = await createTempManager();
  try {
    const account = manager.allAccounts[0];
    await withStubbedFetch(
      (url) => {
        if (isDiscoveryRequest(url)) return discoveryResponse();
        return sseResponse(
          `data: ${JSON.stringify({ response: { candidates: [{ content: { parts: [{ text: "pong" }] } }] } })}\n\n`,
        );
      },
      async (calls) => {
        await probeAccountLiveness(account, manager, modelSettings());
        const streamCalls = calls.filter((c) => c.url.includes(":streamGenerateContent"));
        assert.equal(streamCalls.length, 1, `probe must hit streamGenerateContent once (calls: ${calls.map((c) => c.url).join(", ")})`);
        const body = JSON.parse(streamCalls[0].init.body);
        assert.equal(body.request.generationConfig.maxOutputTokens, 1, "probe must cap output at 1 token");
        const text = JSON.stringify(body.request.contents);
        assert.ok(text.includes("ping"), "probe must send a minimal prompt");
        // The probe must exercise the primary TEXT model: quota buckets are
        // per-model, an image-model probe would miss text-traffic rate limits.
        const exercisesTextModel =
          streamCalls[0].url.includes("gemini-3.8-flash") || JSON.stringify(body).includes("gemini-3.8-flash");
        assert.ok(exercisesTextModel, `probe must target the primary text model (url: ${streamCalls[0].url})`);
      },
    );
  } finally {
    await cleanup();
  }
});

test("probeAccountLiveness surfaces a 429 raised by the streaming path", async () => {
  const { manager, cleanup } = await createTempManager();
  try {
    const account = manager.allAccounts[0];
    await withStubbedFetch(
      (url) => {
        if (isDiscoveryRequest(url)) return discoveryResponse();
        return sseResponse(
          `data: ${JSON.stringify({ error: { message: "429 RESOURCE_EXHAUSTED: Individual quota reached" } })}\n\n`,
        );
      },
      async () => {
        await assert.rejects(
          () => probeAccountLiveness(account, manager, modelSettings()),
          /429|RESOURCE_EXHAUSTED|quota/i,
        );
      },
    );
  } finally {
    await cleanup();
  }
});
