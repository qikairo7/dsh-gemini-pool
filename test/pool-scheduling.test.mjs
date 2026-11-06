import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AccountPoolManager, quotaFractionForAccount } from "../lib/pool.js";

async function createManager() {
  const dir = await mkdtemp(join(tmpdir(), "gemini-pool-scheduling-"));
  const manager = new AccountPoolManager(join(dir, "accounts.json"), join(dir, "legacy.json"));
  await manager.init();
  return {
    manager,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

function quotaWith(fiveHour, remaining, modelIds = ["gemini-3.8-flash"], modelRemaining) {
  return {
    fetchedAt: Date.now(),
    groups: [
      {
        displayName: "Gemini Models",
        buckets: [
          { bucketId: "5h", displayName: "Five Hour Limit Remaining", window: "5h", remainingFraction: fiveHour },
          { bucketId: "weekly", displayName: "Weekly Limit Remaining", window: "weekly", remainingFraction: remaining },
        ],
      },
    ],
    catalogModels: modelIds.map((id) => ({
      id,
      name: id,
      available: true,
      ...(typeof modelRemaining === "number" ? { remainingFraction: modelRemaining } : {}),
      runtimeModels: { "": `${id}-high`, high: `${id}-high` },
    })),
  };
}

test("equal-quota accounts rotate instead of hammering the primary", async () => {
  const { manager, cleanup } = await createManager();
  try {
    for (const email of ["a@example.com", "b@example.com", "c@example.com"]) {
      await manager.addOrUpdateAccount({ email, refresh: "r", access: "a" });
    }
    const accounts = (await manager.getStatus()).accounts;
    for (const account of accounts) await manager.updateAccountQuota(account.id, quotaWith(1, 1));
    const counts = new Map();
    for (let i = 0; i < 9; i++) {
      const [picked] = await manager.getCandidateAccounts("gemini");
      counts.set(picked.email, (counts.get(picked.email) || 0) + 1);
    }
    assert.deepEqual([...counts.values()].sort(), [3, 3, 3]);
  } finally {
    await cleanup();
  }
});

test("weighted rotation favors the account with more quota without starving the other", async () => {
  const { manager, cleanup } = await createManager();
  try {
    await manager.addOrUpdateAccount({ email: "rich@example.com", refresh: "r", access: "a" });
    await manager.addOrUpdateAccount({ email: "poor@example.com", refresh: "r", access: "a" });
    const accounts = (await manager.getStatus()).accounts;
    await manager.updateAccountQuota(accounts[0].id, quotaWith(0.9, 0.9));
    await manager.updateAccountQuota(accounts[1].id, quotaWith(0.1, 0.1));
    const counts = new Map();
    for (let i = 0; i < 20; i++) {
      const [picked] = await manager.getCandidateAccounts("gemini");
      counts.set(picked.email, (counts.get(picked.email) || 0) + 1);
    }
    const rich = counts.get("rich@example.com") || 0;
    const poor = counts.get("poor@example.com") || 0;
    assert.ok(rich > poor * 4, `expected weighted split, got rich=${rich} poor=${poor}`);
    assert.ok(poor > 0, "the lower-quota account must still receive some traffic");
  } finally {
    await cleanup();
  }
});

test("accounts that do not list a model are never chosen for it", async () => {
  const { manager, cleanup } = await createManager();
  try {
    await manager.addOrUpdateAccount({ email: "a@example.com", refresh: "r", access: "a" });
    await manager.addOrUpdateAccount({ email: "b@example.com", refresh: "r", access: "a" });
    const accounts = (await manager.getStatus()).accounts;
    await manager.updateAccountQuota(accounts[0].id, quotaWith(1, 1, ["gemini-3.8-flash"]));
    await manager.updateAccountQuota(accounts[1].id, quotaWith(1, 1, ["gemini-4-argon"]));
    const candidates = await manager.getCandidateAccounts("gemini", "gemini-4-argon");
    assert.deepEqual(candidates.map((account) => account.email), ["b@example.com"]);
  } finally {
    await cleanup();
  }
});

test("per-model quota wins over the family bucket when routing a specific model", () => {
  const account = {
    quota: {
      groups: [
        {
          displayName: "Gemini Models",
          buckets: [{ window: "5h", remainingFraction: 0.9 }],
        },
      ],
      catalogModels: [
        { id: "gemini-4-argon", remainingFraction: 0.2 },
        { id: "gemini-3.8-flash", remainingFraction: 0.9 },
      ],
    },
  };
  assert.equal(quotaFractionForAccount(account, "gemini", "gemini-4-argon"), 0.2);
  assert.equal(quotaFractionForAccount(account, "gemini", "gemini-3.8-flash"), 0.9);
  assert.equal(quotaFractionForAccount(account, "gemini", "unknown-model"), 0.9);
});

test("quotaFractionForAccount reads the real buckets shape and the legacy limits shape", () => {
  const modern = {
    quota: {
      groups: [
        {
          displayName: "Gemini Models",
          buckets: [
            { window: "5h", remainingFraction: 0.47 },
            { window: "weekly", remainingFraction: 0.9 },
          ],
        },
      ],
    },
  };
  assert.equal(quotaFractionForAccount(modern), 0.47);
  const legacy = {
    quota: { groups: [{ name: "gemini", limits: [{ label: "5 hours", remainingFraction: 0.3 }] }] },
  };
  assert.equal(quotaFractionForAccount(legacy), 0.3);
});
