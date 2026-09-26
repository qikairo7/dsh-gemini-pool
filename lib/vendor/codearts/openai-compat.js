import { LlmError, ToolCallId } from "@deepseek-ai/dsh-llm";
import {
  createBlankReasoningSuppressor,
  createReasoningLoopDetector,
  hasUsableToolName,
  isReasoningLoopGuardEnabled,
  isTruncatedArguments,
  normalizeToolArguments,
  readWithIdleTimeout,
  resolveEmptyResponseReason,
  resolveToolPairing,
  splitThinkTaggedContent,
  stripCourseLeakFromHistoryContent,
  stripCourseLeakIfEnabled
} from "./sse.js";
import { normalizeHarnessMessages } from "./message-shape.js";
function contentToText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((block) => typeof block === "object" && block !== null && block.type === "text").map((block) => String(block.text)).join("");
}
const TOOL_RESULT_IMAGE_TEXT = "Attached image(s) from tool result:";
function userContentParts(content, imageUrls) {
  const parts = [];
  let hasImage = false;
  for (const raw of content) {
    if (typeof raw !== "object" || raw === null) continue;
    const block = raw;
    if (block.type === "text") {
      const text = String(block.text ?? "");
      if (text.length > 0) parts.push({ type: "text", text });
      continue;
    }
    if (block.type === "image") {
      hasImage = true;
      const url = block.attachment?.attachmentId === void 0 ? void 0 : imageUrls.get(String(block.attachment.attachmentId));
      parts.push(url === void 0 ? { type: "text", text: "[image unavailable]" } : { type: "image_url", image_url: { url } });
      continue;
    }
    if (block.type === "tool-result" && Array.isArray(block.content)) {
      const inner = userContentParts(block.content, imageUrls);
      if (inner !== void 0) {
        hasImage = true;
        parts.push(...inner);
      } else {
        const text = contentToText(block.content);
        if (text.length > 0) parts.push({ type: "text", text });
      }
    }
  }
  return hasImage && parts.length > 0 ? parts : void 0;
}
function collectImages(content, refs) {
  for (const raw of content) {
    if (typeof raw !== "object" || raw === null) continue;
    const block = raw;
    if (block.type === "image" && typeof block.attachment?.attachmentId === "string") {
      refs.set(block.attachment.attachmentId, block.attachment);
      continue;
    }
    if (block.type === "tool-result" && Array.isArray(block.content)) collectImages(block.content, refs);
  }
}
function serializeMessages(messages, imageUrls) {
  const normalized = normalizeHarnessMessages(messages);
  const wire = [];
  const { keepCallIds, keepResultIds } = resolveToolPairing(normalized);
  let pendingToolImages = [];
  const flushToolImages = () => {
    if (pendingToolImages.length === 0) return;
    wire.push({
      role: "user",
      content: [{ type: "text", text: TOOL_RESULT_IMAGE_TEXT }, ...pendingToolImages]
    });
    pendingToolImages = [];
  };
  for (const message of normalized) {
    if (message.role === "assistant") {
      const content2 = stripCourseLeakFromHistoryContent(
        message.role,
        Array.isArray(message.content) ? message.content : []
      );
      const toolCalls = content2.filter((block) => typeof block === "object" && block !== null && block.type === "tool-call").filter((block) => keepCallIds.has(String(block.id))).map((block) => ({
        id: String(block.id),
        type: "function",
        function: { name: String(block.name), arguments: normalizeToolArguments(String(block.arguments)) }
      }));
      const reasoning = content2.filter((block) => typeof block === "object" && block !== null && block.type === "reasoning").map((block) => String(block.text)).join("");
      const text2 = contentToText(content2);
      flushToolImages();
      wire.push({
        role: "assistant",
        // 正文为空且有工具调用时 content 必须为 null（OpenAI 规范）。
        content: text2.length === 0 && toolCalls.length > 0 ? null : text2,
        ...reasoning.length > 0 ? { reasoning_content: reasoning } : {},
        ...toolCalls.length > 0 ? { tool_calls: toolCalls } : {}
      });
      continue;
    }
    if (message.role === "system") {
      flushToolImages();
      wire.push({ role: "system", content: contentToText(message.content) });
      continue;
    }
    const content = Array.isArray(message.content) ? message.content : [];
    const toolResults = content.filter((block) => typeof block === "object" && block !== null && block.type === "tool-result");
    const text = contentToText(message.content);
    const regular = content.filter((block) => !(typeof block === "object" && block !== null && block.type === "tool-result"));
    const parts = imageUrls === void 0 ? void 0 : userContentParts(regular, imageUrls);
    if (parts !== void 0) {
      flushToolImages();
      wire.push({ role: "user", content: parts });
    } else if (text.length > 0 || toolResults.length === 0) {
      flushToolImages();
      wire.push({ role: "user", content: text });
    }
    for (const result of toolResults) {
      if (!keepResultIds.has(String(result.toolCallId))) continue;
      let resultText = "(no output)";
      if (imageUrls !== void 0 && Array.isArray(result.content)) {
        const resultParts = userContentParts(result.content, imageUrls);
        if (resultParts !== void 0) {
          pendingToolImages.push(...resultParts.filter((part) => part.type !== "text"));
          const joined = resultParts.filter((part) => part.type === "text").map((part) => String(part.text)).join("");
          if (joined.length > 0) resultText = joined;
        } else {
          resultText = contentToText(result.content) || "(no output)";
        }
      } else {
        resultText = contentToText(result.content) || "(no output)";
      }
      wire.push({
        role: "tool",
        tool_call_id: String(result.toolCallId),
        content: resultText
      });
    }
  }
  flushToolImages();
  return wire;
}
function errorMessage(error) {
  if (error instanceof Error) return error.message;
  try {
    return String(error);
  } catch {
    return "unknown error";
  }
}
function errorDetail(body) {
  try {
    const data = JSON.parse(body);
    const nested = typeof data.error === "object" && data.error !== null ? data.error.message : data.error;
    const parts = [
      typeof data.code === "number" || typeof data.code === "string" ? `code=${String(data.code)}` : void 0,
      typeof data.message === "string" ? data.message : void 0,
      typeof data.msg === "string" ? data.msg : void 0,
      typeof nested === "string" ? nested : void 0
    ].filter((value) => value !== void 0);
    if (parts.length > 0) return parts.join(" ");
  } catch {
  }
  return body;
}
function httpErrorCode(status) {
  if (status === 401 || status === 403) return "AUTH";
  if (status === 429) return "RATE_LIMIT";
  if (status === 400) return "INVALID_REQUEST";
  if (status >= 500) return "SERVER";
  return `HTTP_${status}`;
}
function isTransportError(error) {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  if (message.includes("terminated")) return true;
  if (error.name.startsWith("UND_ERR_")) return true;
  if (message.includes("fetch failed")) return true;
  if (message.includes("econnreset") || message.includes("epipe") || message.includes("socket hang up")) return true;
  return false;
}
const RAW_SNIPPET_LIMIT = 400;
async function* consumeOpenAiSse(response, options, config) {
  const { label } = config;
  if (!response.body) throw new LlmError(`${label}: empty model response body`, "EMPTY_RESPONSE");
  const blocks = [];
  let nextIndex = 0;
  const loopGuard = isReasoningLoopGuardEnabled() ? createReasoningLoopDetector() : void 0;
  let loopDetected = false;
  const proseLoopGuard = isReasoningLoopGuardEnabled() ? createReasoningLoopDetector() : void 0;
  let proseLoopDetected = false;
  let proseHasThinkTag = false;
  const suppressor = createBlankReasoningSuppressor();
  const toolCalls = /* @__PURE__ */ new Map();
  const toolOrder = [];
  const toolIds = /* @__PURE__ */ new Map();
  let buffer = "";
  let streamEnded = false;
  let finishReason;
  let gotAnyContent = false;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let firstTokenReceived = false;
  let sawDataFrame = false;
  let rawSnippet = "";
  try {
    for (; ; ) {
      if (streamEnded) break;
      let result;
      try {
        const timeoutMs = firstTokenReceived ? config.chunkTimeoutMs : config.firstTokenTimeoutMs;
        const phase = firstTokenReceived ? "chunk" : "first-token";
        result = await readWithIdleTimeout(reader, timeoutMs, label, options.signal, phase);
        if (!result.done) firstTokenReceived = true;
      } catch (error) {
        if (options.signal?.aborted) throw error;
        if (error instanceof LlmError) throw error;
        if (isTransportError(error)) {
          throw new LlmError(`${label}: sse transport error: ${errorMessage(error)}`, "TRANSPORT", { cause: error });
        }
        throw error;
      }
      if (result.done) break;
      const decoded = decoder.decode(result.value, { stream: true });
      if (rawSnippet.length < RAW_SNIPPET_LIMIT) {
        rawSnippet = (rawSnippet + decoded).slice(0, RAW_SNIPPET_LIMIT);
      }
      buffer += decoded;
      let newline;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line.startsWith("data:")) continue;
        sawDataFrame = true;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") {
          streamEnded = true;
          break;
        }
        let data;
        try {
          data = JSON.parse(payload);
        } catch {
          continue;
        }
        if (data.error !== void 0) {
          throw new LlmError(`${label}: ${data.error.message ?? "unknown error"}`, "SERVER");
        }
        if (data.choices === void 0 && data.code !== void 0 && typeof data.message === "string") {
          const detail = [String(data.code), data.type].filter(Boolean).join("/");
          throw new LlmError(
            `${label}: ${data.message}${detail.length > 0 ? ` (${detail})` : ""}`,
            "SERVER"
          );
        }
        if (data.choices === void 0 && typeof data.message === "string") {
          const status = typeof data.statusCodeValue === "number" ? data.statusCodeValue : void 0;
          const looksLikeError = status !== void 0 && status >= 400 || data.stackTrace !== void 0;
          if (looksLikeError) {
            const suffix = status === void 0 ? "" : ` (status=${status})`;
            throw new LlmError(`${label}: ${data.message}${suffix}`, "SERVER", {
              ...status === void 0 ? {} : { status }
            });
          }
        }
        const choice = data.choices?.[0];
        const delta = choice?.delta;
        if (typeof choice?.finish_reason === "string") {
          finishReason = choice.finish_reason;
        }
        const deltaContent = delta?.content;
        const textDelta = typeof deltaContent === "string" && deltaContent.length > 0 ? deltaContent : !gotAnyContent && typeof choice?.message?.content === "string" ? choice.message.content : void 0;
        if (textDelta !== void 0 && textDelta.length > 0) {
          if (typeof deltaContent === "string" && deltaContent.length > 0) gotAnyContent = true;
          let block = blocks.find((candidate) => candidate.kind === "text");
          if (block === void 0) {
            block = { index: nextIndex++, kind: "text", text: "" };
            blocks.push(block);
            yield { type: "block-start", index: block.index, blockType: "text" };
          }
          if (proseLoopGuard !== void 0) {
            if (proseLoopGuard.observe(textDelta)) proseLoopDetected = true;
          }
          if (!proseHasThinkTag && textDelta.includes("think:")) proseHasThinkTag = true;
          if (!proseLoopDetected) {
            block.text += textDelta;
            yield { type: "text-delta", index: block.index, text: textDelta };
          }
        }
        const reasoningDelta = delta?.reasoning_content ?? delta?.reasoning;
        if (typeof reasoningDelta === "string" && reasoningDelta.length > 0) {
          if (loopGuard !== void 0) {
            if (loopGuard.observe(reasoningDelta)) loopDetected = true;
          }
          if (!loopDetected) {
            const emit = suppressor.feed(reasoningDelta);
            if (emit !== void 0) {
              let block = blocks.find((candidate) => candidate.kind === "reasoning");
              if (block === void 0) {
                block = { index: nextIndex++, kind: "reasoning", text: "" };
                blocks.push(block);
                yield { type: "block-start", index: block.index, blockType: "reasoning" };
              }
              block.text = suppressor.text();
              yield { type: "reasoning-delta", index: block.index, text: emit };
            }
          }
        }
        for (const call of delta?.tool_calls ?? []) {
          const wireIndex = call.index ?? 0;
          if (typeof call.id === "string" && call.id.length > 0) toolIds.set(wireIndex, call.id);
          const callId = toolIds.get(wireIndex) ?? `call_${wireIndex}`;
          let block = toolCalls.get(wireIndex);
          if (block === void 0) {
            block = { index: nextIndex++, text: "", callId, announced: false };
            toolCalls.set(wireIndex, block);
          }
          block.callId = callId;
          if (typeof call.function?.name === "string" && call.function.name.length > 0) {
            block.name = call.function.name;
          }
          const fragment = call.function?.arguments ?? "";
          block.text += fragment;
          if (!block.announced) {
            if (!hasUsableToolName(block.name)) continue;
            block.announced = true;
            toolOrder.push(block.index);
            yield { type: "block-start", index: block.index, blockType: "tool-call" };
            yield {
              type: "tool-call-delta",
              index: block.index,
              id: ToolCallId(callId),
              name: block.name,
              argumentsDelta: block.text
            };
            continue;
          }
          yield {
            type: "tool-call-delta",
            index: block.index,
            id: ToolCallId(callId),
            ...block.name !== void 0 ? { name: block.name } : {},
            argumentsDelta: fragment
          };
        }
        if (data.usage) {
          const promptTokens = data.usage.prompt_tokens ?? 0;
          const cachedTokens = data.usage.prompt_tokens_details?.cached_tokens ?? data.usage.prompt_cache_hit_tokens ?? 0;
          const reasoningTokens = data.usage.completion_tokens_details?.reasoning_tokens;
          yield {
            type: "usage",
            usage: {
              // inputTokens 只计**未命中缓存**的部分，命中部分单列
              // cacheReadTokens，否则缓存命中率显示会偏大。
              inputTokens: cachedTokens > 0 ? promptTokens - cachedTokens : promptTokens,
              outputTokens: data.usage.completion_tokens ?? 0,
              ...cachedTokens > 0 ? { cacheReadTokens: cachedTokens } : {},
              ...reasoningTokens !== void 0 && reasoningTokens > 0 ? { reasoningTokens } : {}
            }
          };
        }
      }
      if (loopDetected) {
        await reader.cancel().catch(() => {
        });
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }
  let blockCount = 0;
  const textBlock = blocks.find((block) => block.kind === "text");
  for (const index of toolOrder) {
    const block = [...toolCalls.values()].find((candidate) => candidate.index === index);
    if (!hasUsableToolName(block.name)) continue;
    blockCount += 1;
    yield {
      type: "block-end",
      index,
      block: {
        type: "tool-call",
        id: ToolCallId(block.callId ?? ""),
        name: block.name,
        // 仅把「无参数工具下发的空分片」补成 {}；**残缺参数保持原样**，
        // 由 max-tokens 判定触发重试 —— 把残缺 JSON 补成 {} 会伪造出
        // 合法外观，让 harness 报 missing required property 而非重试。
        arguments: isTruncatedArguments(block.text) ? block.text : normalizeToolArguments(block.text)
      }
    };
  }
  if (textBlock !== void 0) {
    let textOut = textBlock.text;
    if (proseHasThinkTag) {
      const split = splitThinkTaggedContent(textBlock.text);
      if (split !== void 0) {
        if (split.reasoning !== "") {
          const existing = blocks.find((candidate) => candidate.kind === "reasoning");
          if (existing === void 0) {
            blocks.push({ index: nextIndex++, kind: "reasoning", text: split.reasoning });
          } else {
            existing.text += split.reasoning;
          }
          suppressor.feed(split.reasoning);
        }
        textOut = split.text;
      }
    }
    const truncatedText = proseLoopDetected && proseLoopGuard?.cutAt !== void 0 ? textOut.slice(0, proseLoopGuard.cutAt) : textOut;
    const cleanedText = stripCourseLeakIfEnabled(truncatedText);
    if (cleanedText !== "") {
      blockCount += 1;
      yield { type: "block-end", index: textBlock.index, block: { type: "text", text: cleanedText } };
    }
  }
  const reasoningBlock = blocks.find((block) => block.kind === "reasoning");
  if (reasoningBlock !== void 0 && reasoningBlock.text.trim() !== "") {
    const suppressedReasoning = suppressor.text();
    const reasoningText = loopDetected && loopGuard?.cutAt !== void 0 ? suppressedReasoning.slice(0, loopGuard.cutAt) : suppressedReasoning;
    const cleanedReasoning = stripCourseLeakIfEnabled(reasoningText);
    if (cleanedReasoning !== "") {
      blockCount += 1;
      yield { type: "block-end", index: reasoningBlock.index, block: { type: "reasoning", text: cleanedReasoning } };
    }
  }
  const argsTruncated = [...toolCalls.values()].some((block) => isTruncatedArguments(block.text));
  const incompleteTools = finishReason === void 0 && toolOrder.length > 0;
  const droppedUnnamedCalls = [...toolCalls.values()].some((block) => !block.announced);
  if (!sawDataFrame) {
    const snippet = rawSnippet.trim();
    if (snippet.length > 0) {
      throw new LlmError(
        `${label}: \u54CD\u5E94\u4E0D\u662F SSE\uFF08\u6CA1\u6709\u4EFB\u4F55 data: \u5E27\uFF09\uFF0C\u539F\u6587\u7247\u6BB5\uFF1A${snippet}`,
        "SERVER"
      );
    }
  }
  const truncatedStream = finishReason === void 0 && !streamEnded;
  const reason = loopDetected ? { kind: "max-tokens" } : finishReason === "length" || incompleteTools || truncatedStream || argsTruncated || droppedUnnamedCalls && toolOrder.length === 0 ? { kind: "max-tokens" } : finishReason === "tool_calls" || toolOrder.length > 0 ? { kind: "tool-calls" } : { kind: "stop" };
  yield { type: "finish", reason: resolveEmptyResponseReason(reason, blockCount) };
}
export {
  TOOL_RESULT_IMAGE_TEXT,
  collectImages,
  consumeOpenAiSse,
  contentToText,
  errorDetail,
  errorMessage,
  httpErrorCode,
  isTransportError,
  serializeMessages,
  userContentParts
};
