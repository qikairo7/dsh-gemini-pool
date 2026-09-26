import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
const RUNTIME_INFO_TIMEOUT_MS = 2e4;
let cached;
function candidatePaths() {
  const override = process.env.QODER_MACHINE_TOKEN_PATH;
  if (override !== void 0 && override.length > 0) return [override];
  const suffix = ["Qoder", "SharedClientCache", "cache", "machine_token.json"];
  const paths = [];
  const appData = process.env.APPDATA;
  if (appData !== void 0 && appData.length > 0) {
    paths.push(join(appData, ...suffix));
  }
  const home = homedir();
  paths.push(join(home, "Library", "Application Support", ...suffix));
  paths.push(join(home, ".config", ...suffix));
  return paths;
}
function parseFile(path) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return void 0;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return void 0;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return void 0;
  const record = parsed;
  const token = record.token;
  const type = record.type;
  if (typeof token !== "string" || token.length === 0) return void 0;
  if (typeof type !== "string" || type.length === 0) return void 0;
  return { token, type };
}
function resolveQoderMachineIdentity(forceExecutable) {
  if (cached !== void 0) return cached ?? void 0;
  const live = readFromRuntimeInfo(forceExecutable);
  if (live !== void 0) {
    cached = live;
    return live;
  }
  for (const path of candidatePaths()) {
    const identity = parseFile(path);
    if (identity !== void 0) {
      cached = identity;
      return identity;
    }
  }
  cached = null;
  return void 0;
}
async function resolveQoderMachineIdentityAsync(forceExecutable) {
  if (cached !== void 0) return cached ?? void 0;
  const live = await readFromRuntimeInfoAsync(forceExecutable);
  if (live !== void 0) {
    cached = live;
    return live;
  }
  for (const path of candidatePaths()) {
    const identity = parseFile(path);
    if (identity !== void 0) {
      cached = identity;
      return identity;
    }
  }
  cached = null;
  return void 0;
}
function locateRuntimeInfo(override) {
  const fromEnv = process.env.QODER_RUNTIME_INFO;
  const candidate = override ?? (fromEnv !== void 0 && fromEnv.length > 0 ? fromEnv : void 0);
  if (candidate !== void 0) {
    return existsSync(candidate) ? candidate : void 0;
  }
  const binDir = join(homedir(), ".qoder", ".bin");
  let entries;
  try {
    entries = readdirSync(binDir);
  } catch {
    return void 0;
  }
  const dir = entries.find((name) => name.startsWith("umid-"));
  if (dir === void 0) return void 0;
  const exe = join(binDir, dir, process.platform === "win32" ? "runtime-info.exe" : "runtime-info");
  return existsSync(exe) ? exe : void 0;
}
const RUNTIME_INFO_ENVIRONMENT = "3";
function runtimeInfoArgs() {
  return [RUNTIME_INFO_ENVIRONMENT, "--account-stdin"];
}
function parseRuntimeInfoOutput(out) {
  const start = out.indexOf("{");
  if (start < 0) return void 0;
  let parsed;
  try {
    parsed = JSON.parse(out.slice(start));
  } catch {
    return void 0;
  }
  if (typeof parsed !== "object" || parsed === null) return void 0;
  const record = parsed;
  const token = record.machineToken;
  const type = record.machineType;
  if (typeof token !== "string" || token.length === 0) return void 0;
  if (typeof type !== "string" || type.length === 0) return void 0;
  return { token, type };
}
function readFromRuntimeInfo(override) {
  const exe = locateRuntimeInfo(override);
  if (exe === void 0) return void 0;
  try {
    const out = execFileSync(exe, [...runtimeInfoArgs()], {
      input: JSON.stringify({ account: "" }),
      encoding: "utf8",
      timeout: RUNTIME_INFO_TIMEOUT_MS,
      windowsHide: true
    });
    return parseRuntimeInfoOutput(out);
  } catch {
    return void 0;
  }
}
async function readFromRuntimeInfoAsync(override) {
  const exe = locateRuntimeInfo(override);
  if (exe === void 0) return void 0;
  return await new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    let child;
    try {
      child = spawn(exe, [...runtimeInfoArgs()], { windowsHide: true });
    } catch {
      done(void 0);
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
      }
      done(void 0);
    }, RUNTIME_INFO_TIMEOUT_MS);
    timer.unref?.();
    let stdout = "";
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", () => {
    });
    child.once("error", () => {
      clearTimeout(timer);
      done(void 0);
    });
    child.once("close", () => {
      clearTimeout(timer);
      done(parseRuntimeInfoOutput(stdout));
    });
    child.stdin?.on("error", () => {
    });
    child.stdin?.end(JSON.stringify({ account: "" }));
  });
}
function resetQoderMachineIdentityCache() {
  cached = void 0;
}
function withQoderMachineHeaders(headers) {
  const identity = resolveQoderMachineIdentity();
  if (identity === void 0) return headers;
  return {
    ...headers,
    // 两者必须同时出现（见模块头部消融表：缺一即拿不到可领活动）。
    "Cosy-MachineToken": identity.token,
    "Cosy-MachineType": identity.type
  };
}
async function withQoderMachineHeadersAsync(headers, forceExecutable) {
  const identity = await resolveQoderMachineIdentityAsync(forceExecutable);
  if (identity === void 0) return headers;
  return {
    ...headers,
    "Cosy-MachineToken": identity.token,
    "Cosy-MachineType": identity.type
  };
}
export {
  resetQoderMachineIdentityCache,
  resolveQoderMachineIdentity,
  resolveQoderMachineIdentityAsync,
  runtimeInfoArgs,
  withQoderMachineHeaders,
  withQoderMachineHeadersAsync
};
