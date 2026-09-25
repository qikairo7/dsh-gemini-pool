import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AccountPoolManager } from "../lib/pool.js";

async function createTempManager() {
  const dir = await mkdtemp(join(tmpdir(), "gemini-pool-cooldown-"));
  const accountsFile = join(dir, "accounts.json");
  const legacyFile = join(dir, "legacy.json");
  const manager = new AccountPoolManager(accountsFile, legacyFile);
  await manager.init();
  return {
    manager,
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

// C1: a successful stream must clear only the cooldown window, never the
// accumulated failure counter. Otherwise an intermittently-broken account that
// succeeds once every few calls never reaches disableThreshold and never retires.
test("clearCooldownUntil keeps failureCount so intermittent failures still retire the account", async () => {
  const { manager, cleanup } = await createTempManager();
  try {
    await manager.addOrUpdateAccount({
      email: "flaky@example.com",
      refresh: "dummy_refresh",
      access: "dummy_access",
    });
    const accId = (await manager.getStatus()).accounts[0].id;
    await manager.updateConfig({ cooldownMs: 1000, disableThreshold: 3 });

    await manager.markCooldown(accId, undefined, "fail 1");
    await manager.markCooldown(accId, undefined, "fail 2");
    assert.equal((await manager.getStatus()).accounts[0].failureCount, 2);

    // A stream that succeeds must only clear the cooldown window.
    await manager.clearCooldownUntil(accId);
    let acc = (await manager.getStatus()).accounts[0];
    assert.equal(acc.failureCount, 2, "success must not reset accumulated failureCount");
    assert.equal(acc.cooldownRemainingMs, 0, "success must clear the cooldown window");
    assert.equal(acc.status, "active");

    // The third failure still reaches the threshold and retires the account.
    await manager.markCooldown(accId, undefined, "fail 3");
    acc = (await manager.getStatus()).accounts[0];
    assert.equal(acc.failureCount, 3);
    assert.equal(acc.status, "disabled", "intermittent account must still retire at threshold");
  } finally {
    await cleanup();
  }
});

// The manual re-enable path keeps the full reset semantics.
test("clearCooldown (manual re-enable) still resets failureCount and status", async () => {
  const { manager, cleanup } = await createTempManager();
  try {
    await manager.addOrUpdateAccount({
      email: "manual@example.com",
      refresh: "dummy_refresh",
      access: "dummy_access",
    });
    const accId = (await manager.getStatus()).accounts[0].id;
    await manager.updateConfig({ disableThreshold: 2 });

    await manager.markCooldown(accId, undefined, "fail 1");
    await manager.markCooldown(accId, undefined, "fail 2");
    assert.equal((await manager.getStatus()).accounts[0].status, "disabled");

    await manager.clearCooldown(accId);
    const acc = (await manager.getStatus()).accounts[0];
    assert.equal(acc.failureCount, 0, "manual clear must zero failureCount");
    assert.equal(acc.status, "active", "manual clear must re-enable");
    assert.equal(acc.cooldownRemainingMs, 0);
  } finally {
    await cleanup();
  }
});
