import { EMPTY_RESPONSE_CODE, LlmError } from "@deepseek-ai/dsh-llm";
import { normalizeHarnessMessages } from "./message-shape.js";
async function readWithIdleTimeout(reader, timeoutMs, label, signal, phase = "chunk") {
  if (signal?.aborted) throw signal.reason ?? new Error("aborted");
  let timer;
  const onUserAbort = () => {
    if (timer) clearTimeout(timer);
  };
  signal?.addEventListener("abort", onUserAbort, { once: true });
  const readPromise = reader.read();
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new LlmError(`${label}: sse ${phase} timeout after ${timeoutMs}ms`, "TIMEOUT"));
    }, timeoutMs);
  });
  try {
    const result = await Promise.race([readPromise, timeoutPromise]);
    return { done: result.done, value: result.value };
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? error;
    if (error instanceof LlmError) {
      await reader.cancel().catch(() => {
      });
      throw error;
    }
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    signal?.removeEventListener("abort", onUserAbort);
  }
}
function hasUsableToolName(name) {
  return typeof name === "string" && name.trim().length > 0;
}
function resolveEmptyResponseReason(reason, blockCount) {
  if (blockCount > 0 || reason.kind !== "stop") return reason;
  return {
    kind: "error",
    failure: {
      message: "model returned a completed response with no content",
      code: EMPTY_RESPONSE_CODE
    }
  };
}
function createBlankReasoningSuppressor() {
  let accumulated = "";
  let emitting = false;
  return {
    feed(text) {
      accumulated += text;
      if (emitting) return text;
      if (text.trim() === "") return void 0;
      emitting = true;
      return accumulated;
    },
    text() {
      return accumulated;
    }
  };
}
function resolveToolPairing(messages) {
  const normalized = normalizeHarnessMessages(messages);
  const allResultIds = /* @__PURE__ */ new Set();
  for (const message of normalized) {
    const content = Array.isArray(message.content) ? message.content : [];
    for (const block of content) {
      if (typeof block === "object" && block !== null && block.type === "tool-result") {
        allResultIds.add(String(block.toolCallId));
      }
    }
  }
  const keepCallIds = /* @__PURE__ */ new Set();
  for (const message of normalized) {
    if (message.role !== "assistant") continue;
    const content = Array.isArray(message.content) ? message.content : [];
    const calls = content.filter((block) => typeof block === "object" && block !== null && block.type === "tool-call");
    if (calls.length === 0) continue;
    const usable = calls.filter((block) => hasUsableToolName(block.name));
    if (usable.length === 0) continue;
    if (usable.every((block) => allResultIds.has(String(block.id)))) {
      for (const block of usable) keepCallIds.add(String(block.id));
    }
  }
  const keepResultIds = /* @__PURE__ */ new Set();
  for (const id of keepCallIds) {
    if (allResultIds.has(id)) keepResultIds.add(id);
  }
  return { keepCallIds, keepResultIds };
}
function normalizeToolArguments(raw) {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return "{}";
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return "{}";
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return "{}";
  return trimmed;
}
function isTruncatedArguments(raw) {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return false;
  try {
    JSON.parse(trimmed);
    return false;
  } catch {
    return true;
  }
}
function resolveSliceChars(raw) {
  const value = raw ?? 64;
  return Number.isFinite(value) ? Math.max(1, value) : 64;
}
function createReasoningLoopDetector(options = {}) {
  const windowChars = options.windowChars ?? 3e3;
  const maxDistinctLineRatio = options.maxDistinctLineRatio ?? 0.35;
  const minLines = options.minLines ?? 40;
  const minLoopChars = options.minLoopChars ?? 2e3;
  const sliceChars = resolveSliceChars(options.sliceChars);
  let text = "";
  let detected = false;
  let cutAt;
  let runStart = 0;
  let runChars = 0;
  function feedPiece(piece) {
    text += piece;
    const window = text.slice(Math.max(0, text.length - windowChars));
    const lines = window.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
    const looping = lines.length >= minLines && new Set(lines).size / lines.length < maxDistinctLineRatio;
    if (!looping) {
      runStart = 0;
      runChars = 0;
      return false;
    }
    if (runChars === 0) runStart = text.length - piece.length;
    runChars += piece.length;
    if (runChars < minLoopChars) return false;
    detected = true;
    cutAt = runStart;
    return true;
  }
  return {
    get detected() {
      return detected;
    },
    get cutAt() {
      return cutAt;
    },
    observe(delta) {
      if (detected) return false;
      if (delta.length === 0) return false;
      for (let offset = 0; offset < delta.length; offset += sliceChars) {
        if (feedPiece(delta.slice(offset, offset + sliceChars))) return true;
      }
      return false;
    }
  };
}
function resolveReasoningLoopGuardFlag(raw) {
  if (raw === void 0) return true;
  const value = raw.trim().toLowerCase();
  return !(value === "0" || value === "false" || value === "no" || value === "off");
}
function isReasoningLoopGuardEnabled() {
  return resolveReasoningLoopGuardFlag(process.env.DSH_REASONING_LOOP_GUARD);
}
const THINK_CLOSE_TAG_RE = /<\/think:([0-9a-f]+)>/g;
function splitThinkTaggedContent(raw) {
  if (raw.length === 0) return void 0;
  const re = new RegExp(THINK_CLOSE_TAG_RE.source, "g");
  let last;
  for (let m = re.exec(raw); m !== null; m = re.exec(raw)) last = m;
  if (last === void 0) return void 0;
  if (isQuotedThinkTag(raw, last.index)) return void 0;
  const boundary = last.index;
  const textStart = boundary + last[0].length;
  const reasoning = raw.slice(0, boundary).replace(new RegExp(THINK_CLOSE_TAG_RE.source, "g"), "");
  return { reasoning, text: raw.slice(textStart), textStart };
}
function isQuotedThinkTag(raw, index) {
  const before = raw.slice(0, index).trimEnd();
  if (before.endsWith("`")) return true;
  const after = raw.slice(index).trimStart();
  const tagEnd = raw.indexOf(">", index);
  if (tagEnd !== -1 && raw.slice(tagEnd + 1).trimStart().startsWith("`")) return true;
  const fences = raw.slice(0, index).match(/```/g);
  return fences !== null && fences.length % 2 === 1;
}
const ASCII_LETTER_RE = /[A-Za-z]/;
function stripCourseLeak(text) {
  if (text.length === 0) return text;
  if (!text.includes("course") && !text.includes("\u8BFE")) return text;
  const lines = text.split("\n");
  let changed = false;
  const cleaned = lines.map((line) => {
    const match = /^([ \t]*)(course|课)(.*)$/.exec(line);
    if (match === null) return line;
    const [, indent, word, rest] = match;
    if (word === "course") {
      const first = rest[0];
      if (first !== void 0 && ASCII_LETTER_RE.test(first)) return line;
      const trimmed2 = rest.startsWith(" ") ? rest.slice(1) : rest;
      changed = true;
      return indent + trimmed2;
    }
    const trimmed = rest.startsWith(" ") ? rest.slice(1) : rest;
    changed = true;
    return indent + trimmed;
  });
  return changed ? cleaned.join("\n") : text;
}
function resolveCourseLeakStripFlag(raw) {
  if (raw === void 0) return true;
  const value = raw.trim().toLowerCase();
  return !(value === "0" || value === "false" || value === "no" || value === "off");
}
function isCourseLeakStripEnabled() {
  return resolveCourseLeakStripFlag(process.env.DSH_COURSE_LEAK_STRIP);
}
function stripCourseLeakIfEnabled(text) {
  return isCourseLeakStripEnabled() ? stripCourseLeak(text) : text;
}
function stripCourseLeakFromHistoryContent(role, content) {
  if (role !== "assistant") return content;
  if (!isCourseLeakStripEnabled()) return content;
  let changed = false;
  const cleaned = content.map((raw) => {
    if (typeof raw !== "object" || raw === null) return raw;
    const block = raw;
    if (block.type !== "text" && block.type !== "reasoning") return raw;
    if (typeof block.text !== "string" || block.text.length === 0) return raw;
    const stripped = stripCourseLeak(block.text);
    if (stripped === block.text) return raw;
    changed = true;
    return { ...block, text: stripped };
  });
  return changed ? cleaned : content;
}
export {
  createBlankReasoningSuppressor,
  createReasoningLoopDetector,
  hasUsableToolName,
  isCourseLeakStripEnabled,
  isReasoningLoopGuardEnabled,
  isTruncatedArguments,
  normalizeToolArguments,
  readWithIdleTimeout,
  resolveCourseLeakStripFlag,
  resolveEmptyResponseReason,
  resolveReasoningLoopGuardFlag,
  resolveSliceChars,
  resolveToolPairing,
  splitThinkTaggedContent,
  stripCourseLeak,
  stripCourseLeakFromHistoryContent,
  stripCourseLeakIfEnabled
};
