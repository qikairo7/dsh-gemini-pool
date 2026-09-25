/**
 * HTML/regex escaping and quota text-formatting helpers for the Antigravity adapter.
 * Extracted verbatim from lib/index.js (no behavior change).
 */

export function escapeHtml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
export function remainingPercent(remaining) {
  if (remaining === undefined) return undefined;
  return Math.round(remaining * 1000) / 10;
}

export function progressBar(remaining, width = 20) {
  if (remaining === undefined) return `[${"?".repeat(width)}]`;
  const filled = Math.max(0, Math.min(width, Math.round(remaining * width)));
  return `[${"#".repeat(filled)}${"-".repeat(width - filled)}]`;
}

export function formatReset(resetTime) {
  if (!resetTime) return "n/a";
  const timestamp = Date.parse(resetTime);
  if (!Number.isFinite(timestamp)) return resetTime;
  const delta = timestamp - Date.now();
  if (delta <= 0) return "now";
  const totalMinutes = Math.round(delta / 60000);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}
export function formatQuotaSummary(quota) {
  const lines = [];
  lines.push("Antigravity quota");
  if (quota.planLabel) lines.push(`plan=${quota.planLabel}`);
  lines.push(`project=${quota.projectId}`);
  lines.push(`fetched=${new Date(quota.fetchedAt).toLocaleString()}`);

  if (!quota.groups.length) {
    lines.push("");
    lines.push("No quota groups returned.");
  } else {
    for (const group of quota.groups) {
      lines.push("");
      lines.push(group.displayName);
      for (const bucket of group.buckets) {
        const remaining = remainingPercent(bucket.remainingFraction);
        lines.push(
          `  ${progressBar(bucket.remainingFraction)} ${bucket.displayName}: ${remaining ?? "?"}% left · resets ${formatReset(bucket.resetTime)}`,
        );
      }
    }
  }

  const rows = quota.models.filter((model) => !/tab_|chat_/i.test(model.modelId)).slice(0, 24);
  if (rows.length) {
    lines.push("");
    lines.push("Models");
    const maxId = Math.max(...rows.map((model) => model.modelId.length), 8);
    for (const model of rows) {
      const remaining = remainingPercent(model.remainingFraction);
      const flags = [
        model.recommended ? "recommended" : "",
        model.supportsThinking ? "thinking" : "",
        model.supportsImages ? "images" : "",
      ]
        .filter(Boolean)
        .join(",");
      const display = model.displayName && model.displayName !== model.modelId ? `  ${model.displayName}` : "";
      lines.push(
        `${model.modelId.padEnd(maxId)}  rem ${remaining === undefined ? "  ?" : String(remaining).padStart(5)}%  reset ${formatReset(model.resetTime).padEnd(8)}${flags ? `  [${flags}]` : ""}${display}`,
      );
    }
    lines.push("");
    lines.push("Note: remaining % is pool-shared, not a private per-model budget.");
  }
  return lines.join("\n").trimEnd();
}
