import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountPoolManager } from "../lib/pool.js";

async function makePool(accounts) {
  const dir = await mkdtemp(join(tmpdir(), "gempool-probe-"));
  const file = join(dir, "pool.json");
  await writeFile(file, JSON.stringify({ accounts }));
  return new AccountPoolManager(file, join(dir, "legacy.json"));
}

test("recordProbeSuccess re-enables the account but decays failureCount by one", async () => {
  const pool = await makePool([
    {
      id: "acc-1",
      email: "probe@example.com",
      accessToken: "at",
      refreshToken: "rt",
      failureCount: 3,
      status: "disabled",
      cooldownUntil: Date.now() + 999_999,
    },
  ]);

  await pool.recordProbeSuccess("acc-1");

  const status = await pool.getStatus();
  const acc = status.accounts.find((a) => a.id === "acc-1");
  assert.equal(acc.status, "active");
  assert.ok(
    (acc.cooldownUntil || 0) <= Date.now(),
    "probe success must clear any cooldown window",
  );
  assert.equal(acc.lastError, null);
  assert.equal(acc.failureCount, 2, "exactly one probe success should decay failureCount by exactly one");
});

test("recordProbeSuccess never drives failureCount below zero", async () => {
  const pool = await makePool([
    {
      id: "acc-2",
      email: "fresh@example.com",
      accessToken: "at",
      refreshToken: "rt",
      failureCount: 0,
      status: "disabled",
    },
  ]);

  await pool.recordProbeSuccess("acc-2");

  const acc = (await pool.getStatus()).accounts.find((a) => a.id === "acc-2");
  assert.equal(acc.status, "active");
  assert.equal(acc.failureCount, 0);
});

test("enableAccount keeps full-reset semantics for manual re-enable", async () => {
  const pool = await makePool([
    {
      id: "acc-3",
      email: "manual@example.com",
      accessToken: "at",
      refreshToken: "rt",
      failureCount: 4,
      status: "disabled",
    },
  ]);

  await pool.enableAccount("acc-3");

  const acc = (await pool.getStatus()).accounts.find((a) => a.id === "acc-3");
  assert.equal(acc.status, "active");
  assert.equal(acc.failureCount, 0, "manual re-enable must remain a full reset");
});
