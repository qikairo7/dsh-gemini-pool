import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { BACKUP_FORMAT, BACKUP_VERSION } from "./types.js";
class BackupFormatError extends Error {
}
async function exportBackup(pool, credentials) {
  const state = pool.getStateSnapshot();
  const exported = {};
  const warnings = [];
  for (const entry of state.accounts) {
    try {
      const resolved = await credentials.resolve(credentialRef(entry.credentialRef));
      if (resolved === void 0) {
        warnings.push(`${entry.id}: \u51ED\u636E\u672A\u914D\u7F6E`);
      } else {
        exported[entry.credentialRef] = resolved.value;
      }
    } catch (error) {
      warnings.push(`${entry.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return {
    payload: {
      format: BACKUP_FORMAT,
      version: BACKUP_VERSION,
      exportedAt: (/* @__PURE__ */ new Date()).toISOString(),
      credentials: exported,
      accounts: state.accounts,
      disabledModels: state.disabledModels,
      loomyPermanentLocked: state.loomyPermanentLocked === true
    },
    warnings
  };
}
function assertBackupPayload(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new BackupFormatError("\u5907\u4EFD\u5185\u5BB9\u4E0D\u662F\u5BF9\u8C61");
  }
  const record = value;
  if (record.format !== BACKUP_FORMAT) {
    throw new BackupFormatError(`\u4E0D\u662F ${BACKUP_FORMAT} \u5907\u4EFD\u6587\u4EF6\uFF08format=${String(record.format)}\uFF09`);
  }
  if (record.version !== BACKUP_VERSION) {
    throw new BackupFormatError(`\u4E0D\u652F\u6301\u7684\u5907\u4EFD\u7248\u672C\uFF1A${String(record.version)}\uFF08\u5F53\u524D\u652F\u6301 v${BACKUP_VERSION}\uFF09`);
  }
  if (typeof record.exportedAt !== "string") {
    throw new BackupFormatError("\u5907\u4EFD\u7F3A\u5C11 exportedAt \u5B57\u6BB5");
  }
  if (typeof record.credentials !== "object" || record.credentials === null || Array.isArray(record.credentials)) {
    throw new BackupFormatError("\u5907\u4EFD credentials \u5B57\u6BB5\u65E0\u6548");
  }
  if (!Array.isArray(record.accounts)) {
    throw new BackupFormatError("\u5907\u4EFD accounts \u5B57\u6BB5\u65E0\u6548");
  }
  if (typeof record.disabledModels !== "object" || record.disabledModels === null || Array.isArray(record.disabledModels)) {
    throw new BackupFormatError("\u5907\u4EFD disabledModels \u5B57\u6BB5\u65E0\u6548");
  }
}
async function importBackup(credentials, pool, raw) {
  assertBackupPayload(raw);
  const payload = raw;
  const skipped = [];
  let credentialsImported = 0;
  for (const [refName, value] of Object.entries(payload.credentials)) {
    if (typeof value !== "string") {
      skipped.push(refName);
      continue;
    }
    try {
      await credentials.set(credentialRef(refName), value);
      credentialsImported++;
    } catch (error) {
      skipped.push(refName);
    }
  }
  await pool.replaceAll(payload.accounts, payload.disabledModels, payload.loomyPermanentLocked);
  const now = Date.now();
  const expiredAccounts = payload.accounts.filter(
    (entry) => typeof entry.expiresAt === "number" && Number.isFinite(entry.expiresAt) && entry.expiresAt <= now
  ).length;
  const skippedSet = new Set(skipped);
  const missingCredentials = payload.accounts.filter(
    (entry) => !Object.prototype.hasOwnProperty.call(payload.credentials, entry.credentialRef) || skippedSet.has(entry.credentialRef)
  ).length;
  return {
    credentialsImported,
    accountsImported: payload.accounts.length,
    skipped,
    expiredAccounts,
    missingCredentials
  };
}
export {
  BackupFormatError,
  assertBackupPayload,
  exportBackup,
  importBackup
};
