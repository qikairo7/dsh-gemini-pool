import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AccountPoolManager } from "../lib/pool.js";

async function tempPaths() {
  const dir = await mkdtemp(join(tmpdir(), "gemini-pool-persist-"));
  return {
    file: join(dir, "accounts.json"),
    legacy: join(dir, "legacy.json"),
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

// Regression: an account added and saved by the pool must survive a reload by a
// fresh manager instance. This broke because #load validated a field name that
// the saved account never has (accessToken vs the real `refresh`/`access`),
// throwing during load; the throw was swallowed and the pool came back empty —
// silent loss of every configured account on process restart.
test("saved accounts survive a reload into a fresh manager", async () => {
  const { file, legacy, cleanup } = await tempPaths();
  try {
    const first = new AccountPoolManager(file, legacy);
    await first.init();
    await first.addOrUpdateAccount({
      email: "keep@example.com",
      refresh: "refresh-token-1",
      access: "access-token-1",
      expires: Date.now() + 3600_000,
      projectId: "proj-1",
    });
    assert.equal((await first.getStatus()).accounts.length, 1);

    const reloaded = new AccountPoolManager(file, legacy);
    await reloaded.init();
    const accounts = (await reloaded.getStatus()).accounts;
    assert.equal(accounts.length, 1, "reloaded pool must still contain the saved account");
    assert.equal(accounts[0].email, "keep@example.com");
  } finally {
    await cleanup();
  }
});

// A legacy-migrated account may legitimately have an empty access token (it is
// re-minted from the refresh token on demand). It must still load.
test("account with empty access token but a refresh token still loads", async () => {
  const { file, legacy, cleanup } = await tempPaths();
  try {
    await writeFile(
      file,
      JSON.stringify({
        schedulingMode: "auto",
        accounts: [
          { id: "acc_legacy", email: "legacy@example.com", refresh: "r", access: "", expires: 0 },
        ],
      }),
      "utf8",
    );
    const m = new AccountPoolManager(file, legacy);
    await m.init();
    const accounts = (await m.getStatus()).accounts;
    assert.equal(accounts.length, 1);
    assert.equal(accounts[0].email, "legacy@example.com");
  } finally {
    await cleanup();
  }
});

// A pool file that exists but is corrupt must fail loudly, not silently start
// empty and let legacy migration overwrite a recoverable file.
test("a corrupt pool file throws instead of being silently discarded", async () => {
  const { file, legacy, cleanup } = await tempPaths();
  try {
    await writeFile(file, "{ this is not valid json ", "utf8");
    const m = new AccountPoolManager(file, legacy);
    await assert.rejects(() => m.init(), /corrupt|cannot be parsed/i);
    // The corrupt file must be left untouched (not overwritten by migration).
    assert.equal(await readFile(file, "utf8"), "{ this is not valid json ");
  } finally {
    await cleanup();
  }
});
