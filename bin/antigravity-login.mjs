#!/usr/bin/env node
import { existsSync } from "node:fs";
import { AccountPoolManager, accountsPoolPath } from "../lib/pool.js";
import {
  FileCredentialStore,
  credentialPath,
  loginAndSave,
  terminalInteraction,
} from "../lib/index.js";

const controller = new AbortController();
const args = new Set(process.argv.slice(2));
const logout = args.has("--logout");

for (const signalName of ["SIGINT", "SIGTERM"]) {
  process.once(signalName, () => {
    controller.abort(new Error(`${signalName} received`));
  });
}

try {
  if (logout) {
    const legacy = new FileCredentialStore(credentialPath());
    if (existsSync(legacy.path())) {
      await legacy.delete();
      console.log(`Removed legacy credentials from ${legacy.path()}`);
    }
    const manager = new AccountPoolManager();
    await manager.init();
    for (const account of manager.allAccounts) {
      await manager.removeAccount(account.id);
    }
    console.log(`Removed all Antigravity accounts from pool at ${accountsPoolPath()}`);
    process.exit(0);
  }
  const credentials = await loginAndSave(terminalInteraction(controller.signal));
  const suffix = credentials.email ? ` for ${credentials.email}` : "";
  console.log(`Antigravity login complete${suffix}.`);
  console.log(`Credentials saved to the account pool at ${accountsPoolPath()}`);
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error);
  console.error(`Antigravity login failed: ${detail}`);
  process.exitCode = 1;
}
