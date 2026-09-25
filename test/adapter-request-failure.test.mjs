import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AccountPoolManager } from "../lib/pool.js";
import { AntigravityPoolAdapter } from "../lib/index.js";

// Minimal in-memory model settings store: the adapter only ever calls read().
function modelSettings(overrides = {}) {
  return {
    async read() {
      return { catalogModels: [], enabledModelIds: [], ...overrides };
    },
  };
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

function errorResponse(status, text) {
  return new Response(text, { status, headers: { "content-type": "text/plain" } });
}

async function withStubbedFetch(handler, run) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => handler(String(url), init);
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

async function createTempManager() {
  const dir = await mkdtemp(join(tmpdir(), "gemini-pool-reqfail-"));
  const manager = new AccountPoolManager(join(dir, "accounts.json"), join(dir, "legacy.json"));
  await manager.init();
  return { manager, cleanup: () => rm(dir, { recursive: true, force: true }) };
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

function spyCooldown(manager) {
  const calls = [];
  const original = manager.markCooldown.bind(manager);
  manager.markCooldown = async (id, durationMs, reason) => {
    calls.push({ id, durationMs, reason });
    return original(id, durationMs, reason);
  };
  return calls;
}

// Regression: when every runtime candidate/endpoint fails, the request path
// must throw a classified LlmError built from the tried-endpoints/last-error
// bookkeeping — not a ReferenceError from those variables being out of scope.
// A ReferenceError would also defeat the pool's 429 cooldown/failover because
// isQuotaOrRateLimitError() can no longer recognise the rate-limit text.
test("all-candidates 429 surfaces a rate-limit error and still marks cooldown", async () => {
  const { manager, cleanup } = await createTempManager();
  try {
    const accountId = await addAccount(manager, "quota@example.com");
    await manager.updateConfig({ cooldownMs: 1000, disableThreshold: 5 });
    const cooldowns = spyCooldown(manager);

    const adapter = new AntigravityPoolAdapter(manager, modelSettings(), () => undefined);
    await withStubbedFetch(
      (url) =>
        isDiscoveryRequest(url)
          ? discoveryResponse()
          : errorResponse(429, "429 RESOURCE_EXHAUSTED: Individual quota reached"),
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
            assert.doesNotMatch(
              String(error?.message),
              /is not defined/,
              `error path must not throw a ReferenceError (got: ${error?.message})`,
            );
            assert.match(String(error?.message), /429|quota/i);
            return true;
          },
        );
      },
    );

    assert.equal(cooldowns.length, 1, `429 exhaustion must mark cooldown once (got ${cooldowns.length})`);
    assert.equal(cooldowns[0].id, accountId);
    const acc = (await manager.getStatus()).accounts[0];
    assert.equal(acc.failureCount, 1, "429 exhaustion must accumulate a failure");
  } finally {
    await cleanup();
  }
});
