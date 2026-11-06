import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AccountPoolManager } from "../lib/pool.js";
import { ensureApiKeyForAccount } from "../lib/index.js";

async function withStubbedFetch(handler, run) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  };
  try {
    return await run(calls);
  } finally {
    globalThis.fetch = original;
  }
}

async function createTempManager() {
  const dir = await mkdtemp(join(tmpdir(), "gemini-pool-onboard-"));
  const manager = new AccountPoolManager(join(dir, "accounts.json"), join(dir, "legacy.json"));
  await manager.init();
  return {
    manager,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

test("no project -> loadCodeAssist then onboardUser creates one", async () => {
  const { manager, cleanup } = await createTempManager();
  try {
    await manager.addOrUpdateAccount({
      email: "onboard@example.com",
      refresh: "refresh_onboard",
      access: "access_onboard",
      expires: Date.now() + 3600_000,
    });
    const account = manager.allAccounts[0];

    await withStubbedFetch(
      (url, init) => {
        if (url.includes(":loadCodeAssist")) {
          return new Response(
            JSON.stringify({ currentTier: { id: "free-tier" }, allowedTiers: [{ id: "free-tier", isDefault: true }] }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (url.includes(":listCloudAICompanionProjects")) {
          return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
        }
        if (url.includes(":onboardUser")) {
          assert.deepEqual(JSON.parse(String(init.body)).tier_id, "free-tier");
          return new Response(
            JSON.stringify({ done: true, response: { cloudaicompanionProject: "onboard-project" } }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response("not found", { status: 404 });
      },
      async (calls) => {
        const tokenInfo = await ensureApiKeyForAccount(account, manager);
        assert.equal(tokenInfo.projectId, "onboard-project");
        assert.ok(calls.some((call) => call.url.includes(":onboardUser")), "onboardUser must be called");
        assert.equal(manager.allAccounts[0].projectId, "onboard-project");
      },
    );
  } finally {
    await cleanup();
  }
});
