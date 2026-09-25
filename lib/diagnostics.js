/**
 * Explicit, injectable diagnostics singleton for the Antigravity adapter.
 * Extracted verbatim from lib/index.js (no behavior change): the shared
 * instance is the same module-level mutable object the adapter has always
 * used; createDiagnostics() allows constructing an equivalent blank slate.
 */

export function createDiagnostics() {
  return {
    endpoint: "",
    status: undefined,
    projectId: "",
    resolvedRuntimeModel: "",
    availableModels: "",
    matchedModelDebug: "",
    error: "",
  };
}

export const diagnostics = createDiagnostics();

export function redactSecrets(text) {
  return String(text)
    .replace(/\bya29\.[A-Za-z0-9._~+/-]+=*/g, "[redacted-access-token]")
    .replace(/\b1\/[A-Za-z0-9_-]{20,}/g, "[redacted-refresh-token]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [redacted]")
    .replace(
      /("?(?:access_token|refresh_token|id_token|token|client_secret|code_verifier|authorization)"?\s*[:=]\s*")[^"]*(")/gi,
      "$1[redacted]$2",
    )
    .replace(
      /("?(?:access_token|refresh_token|id_token|token|client_secret|code_verifier|authorization)"?\s*[:=]\s*)[^\s&,}]+/gi,
      "$1[redacted]",
    );
}

export function safeError(error) {
  const raw = error instanceof Error ? error.message : String(error);
  return redactSecrets(raw);
}

export function setLastEndpoint(endpoint) {
  diagnostics.endpoint = endpoint || "";
}

export function setLastStatus(status) {
  diagnostics.status = status;
}

export function setLastProjectId(projectId) {
  diagnostics.projectId = projectId || "";
}

export function setLastResolvedRuntimeModel(modelId) {
  diagnostics.resolvedRuntimeModel = modelId || "";
}

export function setLastAvailableModels(text) {
  diagnostics.availableModels = text || "";
}

export function setLastMatchedModelDebug(text) {
  diagnostics.matchedModelDebug = text || "";
}

export function setLastError(error) {
  diagnostics.error = safeError(error || "");
}

export function getAntigravityDiagnostics() {
  return { ...diagnostics };
}
