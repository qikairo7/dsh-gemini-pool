import {
  attributionHeaders,
  CONTEXT_WINDOW_EXCEEDED_CODE,
  isContextWindowExceededError,
  isQuotaExceededError,
  LlmAdapter,
  LlmError,
  QUOTA_EXCEEDED_CODE
} from "@deepseek-ai/dsh-llm";
import { ToolCallId } from "@deepseek-ai/dsh-llm";
import { providerCatalogVisible } from "./account-pool.js";
import { settingsNamespaceFor } from "./settings-compat.js";
import { isCodeArtsBenefitModel } from "./models.js";
import { normalizeHarnessMessages } from "./message-shape.js";
import { signRequestHuawei } from "./sign.js";
import { createBlankReasoningSuppressor, createReasoningLoopDetector, hasUsableToolName, isReasoningLoopGuardEnabled, isTruncatedArguments, normalizeToolArguments, readWithIdleTimeout, resolveEmptyResponseReason, resolveToolPairing, stripCourseLeakFromHistoryContent, stripCourseLeakIfEnabled } from "./sse.js";
const CHAT_API_BASE = "https://snap-access.cn-north-4.myhuaweicloud.com/api/v2";
const PROVIDER = "codearts";
const DEFAULT_MODELS = [
  "GLM-5.2",
  "GLM-5.1",
  "GLM-5",
  "glm-5.3-flash",
  "openpangu-2.0-flash",
  "openpangu-2.0-pro",
  "deepseek-v4-flash",
  "deepseek-v4-pro",
  "deepseek-v4.1-flash"
];
const CONTEXT_WINDOWS = /* @__PURE__ */ new Map([
  ["GLM-5.2", 202752],
  ["glm-5.3-flash", 1048576],
  ["deepseek-v4-flash", 1048576],
  ["deepseek-v4-pro", 1048576],
  ["deepseek-v4.1-flash", 1e6]
]);
function contentToText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((block) => typeof block === "object" && block !== null && block.type === "text").map((block) => String(block.text)).join("");
}
function serializeMessages(messages) {
  const normalized = normalizeHarnessMessages(messages);
  const wire = [];
  const { keepCallIds, keepResultIds } = resolveToolPairing(normalized);
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
      wire.push({
        role: "assistant",
        content: contentToText(content2),
        // 后端（deepseek-v4-flash/pro）校验要求 assistant 消息必须包含
        // reasoning_content 字段：历史里的推理块在上一轮被持久化，回传时
        // 若缺失该字段会直接 400（"Missing `reasoning_content` field"）。
        // 始终携带该字段（无推理时为空串），确保字段存在。
        reasoning_content: reasoning,
        ...toolCalls.length > 0 ? { tool_calls: toolCalls } : {}
      });
      continue;
    }
    if (message.role === "system") {
      wire.push({ role: "system", content: contentToText(message.content) });
      continue;
    }
    const content = Array.isArray(message.content) ? message.content : [];
    const toolResults = content.filter((block) => typeof block === "object" && block !== null && block.type === "tool-result");
    const text = contentToText(message.content);
    if (text.length > 0 || toolResults.length === 0) wire.push({ role: "user", content: text });
    for (const result of toolResults) {
      if (!keepResultIds.has(String(result.toolCallId))) continue;
      wire.push({
        role: "tool",
        tool_call_id: String(result.toolCallId),
        content: contentToText(result.content) || "(no output)"
      });
    }
  }
  return wire;
}
function isDeepseekV4Model(model) {
  return /^deepseek-v4-(flash|pro)$/.test(model);
}
const DSML_LARGE_PARAM_TOOLS = ["write", "file_write", "apply_patch"];
function needsDsmlToolMode(model, _toolNames) {
  return isDeepseekV4Model(model);
}
function buildDsmlSystemPrompt(tools) {
  const toolJson = JSON.stringify(tools.map((tool) => ({
    name: tool.function.name,
    description: tool.function.description,
    parameters: tool.function.parameters
  })), null, 2);
  return [
    "\u4EE5\u4E0B\u662F\u4F60\u53EF\u7528\u7684\u5DE5\u5177\u53CA\u5176 JSON Schema\u3002\u5F53\u9700\u8981\u8C03\u7528\u5DE5\u5177\u5B8C\u6210\u4EFB\u52A1\u65F6\uFF0C",
    "\u5FC5\u987B\u4F7F\u7528\u539F\u751F DSML \u5DE5\u5177\u8C03\u7528\u8BED\u6CD5\u8F93\u51FA\uFF0C\u683C\u5F0F\u5982\u4E0B\uFF1A",
    '<\uFF5CDSML\uFF5Ctool_calls><\uFF5CDSML\uFF5Cinvoke name="\u5DE5\u5177\u540D"><\uFF5CDSML\uFF5Cparameter name="\u53C2\u6570\u540D" string="true">\u53C2\u6570\u503C</\uFF5CDSML\uFF5Cparameter></\uFF5CDSML\uFF5Cinvoke></\uFF5CDSML\uFF5Ctool_calls>',
    "",
    "\u89C4\u5219\uFF1A",
    "- \u5DE5\u5177\u540D\u5FC5\u987B\u662F\u4E0B\u9762\u5217\u8868\u4E2D\u7684 name\u3002",
    "- \u6BCF\u4E2A\u53C2\u6570\u7528\u4E00\u4E2A <\uFF5CDSML\uFF5Cparameter> \u6807\u7B7E\u5305\u88F9\uFF0C\u53C2\u6570\u503C\u653E\u5728\u6807\u7B7E\u4E4B\u95F4\u3002",
    '- \u5B57\u7B26\u4E32\u53C2\u6570\u52A0 string="true" \u5C5E\u6027\uFF1B\u5BF9\u8C61/\u6570\u7EC4/\u6570\u5B57/\u5E03\u5C14\u53C2\u6570\u4E0D\u8981\u52A0\u8BE5\u5C5E\u6027\u3002',
    "- \u4E00\u6B21\u53EF\u4EE5\u8F93\u51FA\u591A\u4E2A <\uFF5CDSML\uFF5Cinvoke> \u8C03\u7528\uFF08\u5DE5\u5177\u53EF\u4EE5\u5E76\u884C\uFF09\u3002",
    "- \u6587\u4EF6\u5185\u5BB9\u8BF7\u4E00\u6B21\u6027\u5B8C\u6574\u5199\u5165\u5355\u4E2A write \u8C03\u7528\u7684 content \u53C2\u6570\uFF0C\u4E0D\u8981\u62C6\u5206\u6216\u7701\u7565\u3002",
    "",
    "\u5DE5\u5177\u5217\u8868\uFF08JSON Schema\uFF09\uFF1A",
    toolJson
  ].join("\n");
}
const QUEUE_STATUS_BASE = "https://snap-access.cn-north-4.myhuaweicloud.com/api/v1/queue/status";
const QUEUE_RETRY_DELAY_MS = 1e4;
const QUEUE_MAX_ATTEMPTS = 180;
function resolveFirstTokenTimeoutMs() {
  return Number.parseInt(process.env.DSH_CODEARTS_SSE_FIRST_TOKEN_TIMEOUT_MS ?? "", 10) || 3e5;
}
function resolveChunkTimeoutMs() {
  return Number.parseInt(process.env.DSH_CODEARTS_SSE_CHUNK_TIMEOUT_MS ?? "", 10) || 6e5;
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
class SseQueueRetryError extends Error {
  code;
  constructor(code, message) {
    super(message);
    this.name = "SseQueueRetryError";
    this.code = code;
  }
}
function isQueueError(status, body) {
  return status === 400 && (body.includes("TM.00001041") || /peak\s+usage|try\s+again\s+after|peak\s+hours/i.test(body) || /high\s+demand|too\s+many\s+requests/i.test(body));
}
function isAuthError(status, body) {
  if (status === 401 || status === 403) return true;
  return body.includes("APIG.0602") || /invalid\s+token|token\s+expired|token\s+is\s+invalid/i.test(body);
}
function isSseQueueErrorCode(code) {
  return code === "TM.00001041" || /81111|TPM|429|rate.?limit|too many requests|排队|限流/i.test(code);
}
function errorDetail(body) {
  try {
    const data = JSON.parse(body);
    const error = typeof data.error === "object" && data.error !== null ? data.error : void 0;
    const parts = [
      typeof error?.code === "string" ? error.code : void 0,
      typeof error?.type === "string" ? error.type : void 0,
      typeof error?.message === "string" ? error.message : void 0,
      typeof data.error_code === "string" ? data.error_code : void 0,
      typeof data.error_msg === "string" ? data.error_msg : void 0,
      typeof data.message === "string" ? data.message : void 0
    ].filter((value) => value !== void 0);
    if (parts.length > 0) return parts.join(" ");
  } catch {
  }
  return body;
}
function httpErrorCode(status, body) {
  if (status === 401 || status === 403) return "AUTH";
  const detail = errorDetail(body);
  if (isQuotaExceededError(detail)) return QUOTA_EXCEEDED_CODE;
  if (status === 429) return "RATE_LIMIT";
  if (status === 400) {
    if (isContextWindowExceededError(detail)) return CONTEXT_WINDOW_EXCEEDED_CODE;
    return "INVALID_REQUEST";
  }
  if (status >= 500) return "SERVER";
  return `HTTP_${status}`;
}
function delay(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
function errorMessage(error) {
  if (error instanceof Error) return error.message;
  try {
    return String(error);
  } catch {
    return "unknown error";
  }
}
function readCodeArtsChunk(reader, timeoutMs, signal, phase = "chunk") {
  return readWithIdleTimeout(reader, timeoutMs, "codearts", signal, phase);
}
const DSML_TOOL_CALLS_OPEN = "<\uFF5CDSML\uFF5Ctool_calls>";
const DSML_TOOL_CALLS_CLOSE = "</\uFF5CDSML\uFF5Ctool_calls>";
const DSML_INVOKE_OPEN_PREFIX = "<\uFF5CDSML\uFF5Cinvoke";
const DSML_INVOKE_CLOSE = "</\uFF5CDSML\uFF5Cinvoke>";
const DSML_PARAM_OPEN_PREFIX = "<\uFF5CDSML\uFF5Cparameter";
const DSML_PARAM_CLOSE = "</\uFF5CDSML\uFF5Cparameter>";
const THOUGHT_OPEN = "<thought>";
const THOUGHT_CLOSE = "</thought>";
function tryParseScalar(value) {
  if (value === "") return "";
  const trimmed = value.trim();
  if (trimmed === "") return value;
  if (trimmed === "null") return null;
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const decoded = JSON.parse(trimmed);
      if (typeof decoded === "string") return tryParseScalar(decoded);
      return decoded;
    } catch {
    }
  }
  if (/^-?\d+$/.test(trimmed)) return Number(trimmed);
  if (/^-?\d+\.\d+$/.test(trimmed)) return Number(trimmed);
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      return JSON.parse(trimmed);
    } catch {
    }
  }
  return value;
}
function parseDsmlInvoke(block) {
  const nameMatch = /name\s*=\s*"([^"]*)"/.exec(block);
  if (nameMatch === null) return void 0;
  const name = nameMatch[1];
  const params = {};
  let cursor = 0;
  for (; ; ) {
    const openStart = block.indexOf(DSML_PARAM_OPEN_PREFIX, cursor);
    if (openStart === -1) break;
    const openEnd = block.indexOf(">", openStart);
    if (openEnd === -1) break;
    const openTag = block.slice(openStart, openEnd + 1);
    const paramNameMatch = /name\s*=\s*"([^"]*)"/.exec(openTag);
    if (paramNameMatch === null) {
      cursor = openEnd + 1;
      continue;
    }
    const paramName = paramNameMatch[1];
    const closeStart = block.indexOf(DSML_PARAM_CLOSE, openEnd + 1);
    if (closeStart === -1) break;
    const value = block.slice(openEnd + 1, closeStart);
    const isString = /string\s*=\s*"true"/.test(openTag);
    if (isString) {
      const parsed = tryParseScalar(value);
      params[paramName] = parsed;
    } else {
      try {
        const parsed = JSON.parse(value);
        params[paramName] = typeof parsed === "string" ? tryParseScalar(parsed) : parsed;
      } catch {
        params[paramName] = value;
      }
    }
    cursor = closeStart + DSML_PARAM_CLOSE.length;
  }
  return { name, arguments: JSON.stringify(params) };
}
function parseDsmlToolCalls(block) {
  let inner = block;
  if (inner.startsWith(DSML_TOOL_CALLS_OPEN)) inner = inner.slice(DSML_TOOL_CALLS_OPEN.length);
  if (inner.endsWith(DSML_TOOL_CALLS_CLOSE)) inner = inner.slice(0, inner.length - DSML_TOOL_CALLS_CLOSE.length);
  const calls = [];
  let cursor = 0;
  for (; ; ) {
    const openStart = inner.indexOf(DSML_INVOKE_OPEN_PREFIX, cursor);
    if (openStart === -1) break;
    const openEnd = inner.indexOf(">", openStart);
    if (openEnd === -1) break;
    const closeStart = inner.indexOf(DSML_INVOKE_CLOSE, openEnd + 1);
    if (closeStart === -1) break;
    const invokeBlock = inner.slice(openStart, closeStart + DSML_INVOKE_CLOSE.length);
    const parsed = parseDsmlInvoke(invokeBlock);
    if (parsed === void 0) return void 0;
    calls.push(parsed);
    cursor = closeStart + DSML_INVOKE_CLOSE.length;
  }
  return calls;
}
function longestOpenPrefixTail(buffer, prefixes) {
  let keepLen = 0;
  const maxCheck = Math.min(buffer.length, Math.max(...prefixes.map((p) => p.length)));
  for (let i = 1; i <= maxCheck; i++) {
    const tail = buffer.slice(buffer.length - i);
    if (prefixes.some((p) => p.startsWith(tail))) keepLen = i;
  }
  return keepLen;
}
class DsmlContentExtractor {
  buffer = "";
  state = "normal";
  feed(chunk) {
    let text = "";
    let reasoning = "";
    const toolCalls = [];
    this.buffer += chunk;
    for (; ; ) {
      if (this.state === "normal") {
        const thoughtIdx = this.buffer.indexOf(THOUGHT_OPEN);
        const dsmlIdx = this.buffer.indexOf(DSML_TOOL_CALLS_OPEN);
        let openIdx = -1;
        let nextState = "in-thought";
        if (thoughtIdx !== -1 && (dsmlIdx === -1 || thoughtIdx < dsmlIdx)) {
          openIdx = thoughtIdx;
          nextState = "in-thought";
        } else if (dsmlIdx !== -1) {
          openIdx = dsmlIdx;
          nextState = "in-dsml";
        }
        if (openIdx === -1) {
          const keepLen = longestOpenPrefixTail(this.buffer, [THOUGHT_OPEN, DSML_TOOL_CALLS_OPEN]);
          if (keepLen === 0) {
            text += this.buffer;
            this.buffer = "";
          } else if (this.buffer.length > keepLen) {
            text += this.buffer.slice(0, this.buffer.length - keepLen);
            this.buffer = this.buffer.slice(this.buffer.length - keepLen);
          }
          break;
        }
        if (openIdx > 0) text += this.buffer.slice(0, openIdx);
        this.buffer = this.buffer.slice(openIdx);
        const openLen = nextState === "in-thought" ? THOUGHT_OPEN.length : DSML_TOOL_CALLS_OPEN.length;
        this.buffer = this.buffer.slice(openLen);
        this.state = nextState;
        continue;
      }
      if (this.state === "in-thought") {
        const closeIdx2 = this.buffer.indexOf(THOUGHT_CLOSE);
        if (closeIdx2 === -1) {
          const keepLen = longestOpenPrefixTail(this.buffer, [THOUGHT_CLOSE]);
          if (keepLen === 0) {
            reasoning += this.buffer;
            this.buffer = "";
          } else if (this.buffer.length > keepLen) {
            reasoning += this.buffer.slice(0, this.buffer.length - keepLen);
            this.buffer = this.buffer.slice(this.buffer.length - keepLen);
          }
          break;
        }
        if (closeIdx2 > 0) reasoning += this.buffer.slice(0, closeIdx2);
        this.buffer = this.buffer.slice(closeIdx2 + THOUGHT_CLOSE.length);
        this.state = "normal";
        continue;
      }
      const closeIdx = this.buffer.indexOf(DSML_TOOL_CALLS_CLOSE);
      if (closeIdx === -1) {
        break;
      }
      const block = this.buffer.slice(0, closeIdx + DSML_TOOL_CALLS_CLOSE.length);
      const parsed = parseDsmlToolCalls(block);
      if (parsed === void 0) {
        text += block;
      } else {
        toolCalls.push(...parsed);
      }
      this.buffer = this.buffer.slice(closeIdx + DSML_TOOL_CALLS_CLOSE.length);
      this.state = "normal";
      continue;
    }
    return { text, reasoning, toolCalls };
  }
  flush() {
    const remaining = this.buffer;
    this.buffer = "";
    if (this.state === "in-thought") {
      this.state = "normal";
      return { text: "", reasoning: remaining };
    }
    if (this.state === "in-dsml") {
      this.state = "normal";
      return { text: DSML_TOOL_CALLS_OPEN + remaining, reasoning: "" };
    }
    this.state = "normal";
    return { text: remaining, reasoning: "" };
  }
}
class CodeArtsAdapter extends LlmAdapter {
  constructor(options) {
    super();
    this.options = options;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.chatId = options.chatId ?? crypto.randomUUID().replace(/-/g, "");
    this.sessionId = options.sessionId ?? crypto.randomUUID().replace(/-/g, "");
  }
  options;
  fetchImpl;
  chatId;
  sessionId;
  /**
   * 描述本适配器拥有的 provider 路由。
   *
   * 与 BuddyAdapter 同款防御：DSH 校验 `info.id === provider`，且模型设置页
   * 会用该 id 计算 `deriveKeyRef(provider)`（内部 `provider.toUpperCase()`）。
   * 入参异常时回退到 PROVIDER 常量，避免客户端抛
   * `undefined.toUpperCase is not a function`。
   */
  providerInfo(provider) {
    const id = typeof provider === "string" && provider.length > 0 ? provider : PROVIDER;
    return { id, name: "CodeArts Agent" };
  }
  /** 动态模型缓存（首次 listModels 成功后填充）。 */
  remoteModels;
  /**
   * 懒加载远端模型目录。resolveModel 可能先于 listModels 被调用
   * （如直接进入会话），此时同样触发远端拉取。
   */
  async ensureRemoteModels() {
    if (this.remoteModels !== void 0 || this.options.fetchRemoteModels === void 0) return;
    try {
      const models = await this.options.fetchRemoteModels();
      if (models.length > 0) this.remoteModels = models;
    } catch {
    }
  }
  /**
   * 完整模型目录（**不应用用户黑名单**）。
   *
   * 设置页必须渲染被关闭的模型（否则用户无法重新打开），而 `listModels` 会按
   * 黑名单过滤掉它们 —— RPC 层只能凭裸 id 补回，展示名随之丢失
   * （用户报障：「关闭的就没有显示倍率」）。CodeArts 目录虽无倍率，但同样
   * 需要正确的 `name`（否则关闭项显示 `deepseek-v4-flash` 这类裸 id）。
   */
  listAllModels() {
    const source = this.remoteModels ?? DEFAULT_MODELS.map((id) => ({ id, name: id }));
    return source.filter((m) => !/-VL-/i.test(m.id) && !/-VL$/i.test(m.id)).map((m) => ({ id: m.id, name: m.name }));
  }
  async listModels(_provider) {
    if (!await providerCatalogVisible(this.options.accountPool, PROVIDER)) return [];
    await this.ensureRemoteModels();
    const visible = this.listAllModels();
    const disabled = this.options.accountPool?.disabledModelsFor(PROVIDER);
    const listed = disabled === void 0 || disabled.size === 0 ? visible : visible.filter((m) => !disabled.has(m.id));
    return listed.map((m) => ({ provider: PROVIDER, id: m.id, name: m.name, inputModalities: ["text"] }));
  }
  async resolveModel(provider, model, _signal) {
    await this.ensureRemoteModels();
    const remoteModel = this.remoteModels?.find((m) => m.id === model);
    const name = remoteModel?.name ?? model;
    const contextWindow = CONTEXT_WINDOWS.get(model);
    const resolved = { provider, id: model, name };
    if (contextWindow !== void 0) resolved.context = { contextWindow };
    return resolved;
  }
  async prepareCall(provider, model, signal) {
    return {
      model: { ...await this.resolveModel(provider, model, signal), inputModalities: ["text"] },
      stream: (options) => this.stream(options)
    };
  }
  async *stream(options) {
    let credential = await this.options.resolveCredential();
    if (credential === void 0 || Date.parse(credential.expires_at) <= Date.now()) {
      await this.options.refresh();
      credential = await this.options.resolveCredential();
    }
    if (credential === void 0 || !credential.access_key_id || !credential.secret_access_key || !credential.security_token) {
      throw new LlmError("codearts: no usable credential; log in first", "MISSING_CREDENTIAL");
    }
    let currentAccountId = "";
    if (this.options.accountPool && credential?.access_key_id) {
      try {
        currentAccountId = await this.options.accountPool.findAccountIdByCredential(
          "codearts",
          credential.access_key_id
        );
      } catch (error) {
        console.warn("[codearts] \u8D26\u53F7\u5339\u914D\u5931\u8D25\uFF08\u4E0D\u5F71\u54CD\u672C\u6B21\u8BF7\u6C42\uFF09:", error);
      }
    }
    const messages = serializeMessages(options.messages);
    if (options.system !== void 0 && options.system.length > 0) {
      messages.unshift({ role: "system", content: options.system });
    }
    const tools = options.tools?.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters
      }
    }));
    let wireTools = tools;
    if (wireTools !== void 0 && needsDsmlToolMode(options.model, wireTools.map((tool) => tool.function.name))) {
      messages.splice(messages.findIndex((m) => m.role === "system") + 1, 0, { role: "system", content: buildDsmlSystemPrompt(wireTools) });
      wireTools = void 0;
    }
    const body = JSON.stringify({
      model: options.model,
      messages,
      stream: true,
      // prompt_cache_key 让服务端启用前缀缓存并在 usage 中返回 cached_tokens，
      // 缺少该字段时缓存命中恒为 0（实测 2026-08-24）。
      prompt_cache_key: this.sessionId,
      // include/reasoning_summary 对齐 Rust 端 CodeArtsExtraFields，
      // 让服务端返回加密 reasoning 内容与摘要。
      include: ["reasoning.encrypted_content"],
      reasoning_summary: "auto",
      // 对齐 CodeArts Agent IDE 请求体（deveco-code 内核日志实证）：
      // tool_stream=true 让后端将超大工具调用参数（如大文件 file_write）
      // 分段流式传输，避免单次 SSE 事件过大导致连接被掐断
      // （error decoding response body）。deepseek-v4 的 DSML 路径不受此
      // 影响，保留该字段与 IDE 对齐。
      tool_stream: true,
      // 输出上限（对齐 deveco-code-rust 参考实现 codearts.rs 的 max_tokens 配置）：
      // 大文件 write 工具参数（如 1000-2000+ 行文档）需要数万 token 的生成空间，
      // 若沿用后端默认输出上限，参数 JSON 会在中途被截断成非法 JSON，harness
      // 工具校验报 `invalid arguments: "arguments" must be an object`。
      // 参考实现 e2e 实测：65536 可用，131072 反而触发空流被后端拒绝；
      // 显式传入的 options.maxTokens 优先，未设置时默认 65536。
      max_tokens: options.maxTokens ?? 65536,
      ...wireTools !== void 0 && wireTools.length > 0 ? { tools: wireTools } : {}
    });
    const url = `${CHAT_API_BASE}/chat/completions`;
    let response;
    let queueAttempts = 0;
    let authRefreshed = false;
    const rateLimitTried = /* @__PURE__ */ new Set();
    if (currentAccountId) rateLimitTried.add(currentAccountId);
    const isBenefitModel = isCodeArtsBenefitModel(options.model);
    for (; ; ) {
      const extraSignedHeaders = isBenefitModel ? { maas_type: "benefit" } : void 0;
      const signed = await signRequestHuawei(
        credential.access_key_id,
        credential.secret_access_key,
        credential.security_token,
        "POST",
        url,
        new TextEncoder().encode(body),
        extraSignedHeaders
      );
      const headers = new Headers(attributionHeaders());
      signed.forEach((value, key) => {
        if (key !== "content-type") headers.set(key, value);
      });
      headers.set("Content-Type", "application/json");
      headers.set("Chat-Id", this.chatId);
      headers.set("Session-Id", this.sessionId);
      headers.set("lang", "en");
      response = await this.fetchImpl(url, {
        method: "POST",
        headers,
        body,
        signal: options.signal
      });
      if (response.ok) {
        try {
          yield* this.consumeSse(response, options);
          break;
        } catch (error) {
          if (!(error instanceof SseQueueRetryError)) throw error;
        }
      } else {
        const errorText = await response.text().catch(() => "");
        if (isAuthError(response.status, errorText) && !authRefreshed) {
          authRefreshed = true;
          await this.options.refresh();
          credential = await this.options.resolveCredential();
          if (credential === void 0 || !credential.access_key_id || !credential.secret_access_key || !credential.security_token) {
            throw new LlmError("codearts: credential missing after refresh; log in again", "MISSING_CREDENTIAL");
          }
          continue;
        }
        if (this.options.accountPool && isRateLimited(errorText)) {
          const parsed = parseRateLimitError(errorText, options.model);
          if (parsed) {
            if (currentAccountId) {
              await this.options.accountPool.updateModelRateLimit(
                currentAccountId,
                parsed.modelId,
                parsed.resetTimeMs
              );
            }
            const next = await this.options.accountPool.getAvailableAccount("codearts", options.model);
            if (next && !rateLimitTried.has(next.entry.id)) {
              rateLimitTried.add(next.entry.id);
              credential = next.credential;
              currentAccountId = next.entry.id;
              authRefreshed = false;
              continue;
            }
            throw new LlmError(
              `codearts: \u6A21\u578B ${options.model} \u6240\u6709\u8D26\u53F7\u5747\u53D7\u9650\uFF0C\u8BF7\u7A0D\u540E\u518D\u8BD5`,
              "QUOTA_EXCEEDED"
            );
          }
        }
        if (!isQueueError(response.status, errorText)) {
          const probe = await this.queryQueueStatus(credential, options.model, options.signal);
          if (probe === void 0 || probe.status === "working") {
            const code = httpErrorCode(response.status, errorText);
            throw new LlmError(`codearts: model request failed with HTTP ${response.status}`, code, { status: response.status });
          }
        }
      }
      queueAttempts += 1;
      if (queueAttempts > QUEUE_MAX_ATTEMPTS) {
        throw new LlmError("codearts: queue wait timed out after 30 minutes", "QUEUE");
      }
      if (options.signal?.aborted) throw new LlmError("codearts: request aborted while waiting in queue", "QUEUE");
      const status = await this.queryQueueStatus(credential, options.model, options.signal);
      if (status?.status === "error" || status?.status === "queue_full") {
        throw new LlmError(`codearts: ${status.message || `queue status: ${status.status}`}`, "QUEUE");
      }
      await delay(QUEUE_RETRY_DELAY_MS, options.signal);
    }
  }
  /**
   * 消费一个 HTTP 200 的 SSE chat 响应并产出 StreamChunk。
   *
   * CodeArts 后端有时以 HTTP 200 + SSE 内嵌错误事件的形式返回排队/限流
   * （如 `InferHub.ModelArts.81111.429` TPM 超限，事件形如
   * `{"text":"[DONE]","error_code":"...","error_msg":"..."}`），而不是
   * 4xx——这类错误若直接当成流结束会被静默吞掉（表现为"思考后无输出"）。
   * 本方法解析每个 SSE 事件的 `error_code`/`error_msg`：可重试的排队/限流
   * 错误抛 {@link SseQueueRetryError} 让外层重试循环按 TM.00001041 同等
   * 处理（10s 间隔重试整个 chat 请求）；不可重试错误抛普通 LlmError。
   */
  async *consumeSse(response, options) {
    if (!response.body) throw new LlmError("codearts: empty model response body", "EMPTY_RESPONSE");
    const blocks = [];
    let nextIndex = 0;
    const toolCalls = /* @__PURE__ */ new Map();
    const toolOrder = [];
    let buffer = "";
    let streamEnded = false;
    let finishReason;
    const loopGuard = isReasoningLoopGuardEnabled() ? createReasoningLoopDetector() : void 0;
    let loopDetected = false;
    const proseLoopGuard = isReasoningLoopGuardEnabled() ? createReasoningLoopDetector() : void 0;
    let proseLoopDetected = false;
    const suppressor = createBlankReasoningSuppressor();
    const dsmlContentExtractor = new DsmlContentExtractor();
    const dsmlReasoningExtractor = new DsmlContentExtractor();
    async function* emitDsmlFeed(text, reasoning, dsmlCalls) {
      if (text.length > 0) {
        let block = blocks.find((candidate) => candidate.kind === "text");
        if (block === void 0) {
          block = { index: nextIndex++, kind: "text", text: "" };
          blocks.push(block);
          yield { type: "block-start", index: block.index, blockType: "text" };
        }
        if (proseLoopGuard !== void 0) {
          if (proseLoopGuard.observe(text)) proseLoopDetected = true;
        }
        if (!proseLoopDetected) {
          block.text += text;
          yield { type: "text-delta", index: block.index, text };
        }
      }
      if (reasoning.length > 0) {
        if (loopGuard !== void 0) {
          if (loopGuard.observe(reasoning)) loopDetected = true;
        }
        if (!loopDetected) {
          const emit = suppressor.feed(reasoning);
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
      for (const call of dsmlCalls) {
        if (!hasUsableToolName(call.name)) continue;
        const wireIndex = toolCalls.size;
        const block = {
          index: nextIndex++,
          text: call.arguments,
          name: call.name,
          callId: ToolCallId(`dsml-${crypto.randomUUID().replace(/-/g, "")}`),
          announced: true
        };
        toolCalls.set(wireIndex, block);
        toolOrder.push(block.index);
        yield { type: "block-start", index: block.index, blockType: "tool-call" };
        yield {
          type: "tool-call-delta",
          index: block.index,
          id: block.callId,
          name: block.name,
          argumentsDelta: call.arguments
        };
      }
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let firstTokenReceived = false;
    try {
      for (; ; ) {
        if (streamEnded) break;
        let done;
        let value;
        try {
          const timeoutMs = firstTokenReceived ? resolveChunkTimeoutMs() : resolveFirstTokenTimeoutMs();
          const phase = firstTokenReceived ? "chunk" : "first-token";
          const result = await readCodeArtsChunk(reader, timeoutMs, options.signal, phase);
          done = result.done;
          value = result.value;
          if (!done) firstTokenReceived = true;
        } catch (error) {
          if (options.signal?.aborted) throw error;
          if (error instanceof LlmError) throw error;
          if (isTransportError(error)) {
            throw new LlmError(`codearts: sse transport error: ${errorMessage(error)}`, "TRANSPORT", { cause: error });
          }
          throw error;
        }
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let newline;
        while ((newline = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (!line.startsWith("data:")) continue;
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
          if (typeof data.error_code === "string" && data.error_code.length > 0) {
            const message = typeof data.error_msg === "string" && data.error_msg.length > 0 ? data.error_msg : data.error_code;
            if (isSseQueueErrorCode(data.error_code)) {
              throw new SseQueueRetryError(data.error_code, message);
            }
            throw new LlmError(`codearts: ${message}`, "INVALID_REQUEST", { status: 200 });
          }
          const choice = data.choices?.[0];
          const delta = choice?.delta;
          if (typeof choice?.finish_reason === "string") {
            finishReason = choice.finish_reason;
          }
          if (delta?.content) {
            const { text, reasoning, toolCalls: dsmlCalls } = dsmlContentExtractor.feed(delta.content);
            yield* emitDsmlFeed(text, reasoning, dsmlCalls);
          }
          if (delta?.reasoning_content) {
            const { text, reasoning, toolCalls: reasoningDsmlCalls } = dsmlReasoningExtractor.feed(delta.reasoning_content);
            const thinking = text + reasoning;
            if (thinking.length > 0) {
              if (loopGuard !== void 0) {
                if (loopGuard.observe(thinking)) loopDetected = true;
              }
              if (!loopDetected) {
                const emit = suppressor.feed(thinking);
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
            for (const call of reasoningDsmlCalls) {
              if (!hasUsableToolName(call.name)) continue;
              const wireIndex = toolCalls.size;
              const block = {
                index: nextIndex++,
                text: call.arguments,
                name: call.name,
                callId: ToolCallId(`dsml-${crypto.randomUUID().replace(/-/g, "")}`),
                announced: true
              };
              toolCalls.set(wireIndex, block);
              toolOrder.push(block.index);
              yield { type: "block-start", index: block.index, blockType: "tool-call" };
              yield {
                type: "tool-call-delta",
                index: block.index,
                id: block.callId,
                name: block.name,
                argumentsDelta: call.arguments
              };
            }
          }
          for (const call of delta?.tool_calls ?? []) {
            const wireIndex = call.index ?? 0;
            let block = toolCalls.get(wireIndex);
            if (block === void 0) {
              block = { index: nextIndex++, text: "", announced: false };
              toolCalls.set(wireIndex, block);
            }
            if (call.id !== void 0) block.callId = call.id;
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
                id: ToolCallId(block.callId ?? ""),
                name: block.name,
                argumentsDelta: block.text
              };
              continue;
            }
            yield {
              type: "tool-call-delta",
              index: block.index,
              id: ToolCallId(block.callId ?? ""),
              ...block.name !== void 0 ? { name: block.name } : {},
              argumentsDelta: fragment
            };
          }
          if (data.usage) {
            const promptTokens = data.usage.prompt_tokens ?? 0;
            const cachedTokens = data.usage.prompt_tokens_details?.cached_tokens ?? data.usage.prompt_cache_hit_tokens ?? 0;
            const cacheWriteTokens = data.usage.prompt_tokens_details?.cache_write_tokens;
            const reasoningTokens = data.usage.completion_tokens_details?.reasoning_tokens;
            yield {
              type: "usage",
              usage: {
                inputTokens: cachedTokens > 0 ? promptTokens - cachedTokens : promptTokens,
                outputTokens: data.usage.completion_tokens ?? 0,
                ...cachedTokens > 0 ? { cacheReadTokens: cachedTokens } : {},
                ...cacheWriteTokens !== void 0 && cacheWriteTokens > 0 ? { cacheWriteTokens } : {},
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
    {
      const f = dsmlContentExtractor.flush();
      if (f.text.length > 0 || f.reasoning.length > 0) yield* emitDsmlFeed(f.text, f.reasoning, []);
    }
    {
      const f = dsmlReasoningExtractor.flush();
      if (f.text.length > 0 || f.reasoning.length > 0) yield* emitDsmlFeed(f.text, f.reasoning, []);
    }
    const textBlock = blocks.find((block) => block.kind === "text");
    const reasoningBlock = blocks.find((block) => block.kind === "reasoning");
    const reasoningText = stripCourseLeakIfEnabled(
      loopDetected && loopGuard?.cutAt !== void 0 ? suppressor.text().slice(0, loopGuard.cutAt) : suppressor.text()
    );
    const reasoningHasDsml = reasoningText.includes("\uFF5CDSML\uFF5C");
    const truncatedText = proseLoopDetected && proseLoopGuard?.cutAt !== void 0 ? (textBlock?.text ?? "").slice(0, proseLoopGuard.cutAt) : void 0;
    const visible = truncatedText !== void 0 ? stripCourseLeakIfEnabled(truncatedText) : textBlock !== void 0 && textBlock.text !== "" ? stripCourseLeakIfEnabled(textBlock.text) : reasoningBlock !== void 0 && toolOrder.length === 0 && !reasoningHasDsml ? reasoningText : "";
    let blockCount = 0;
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
          // 同上：空分片补 {}，残缺参数保持原样交由截断判定处理。
          arguments: isTruncatedArguments(block.text) ? block.text : normalizeToolArguments(block.text)
        }
      };
    }
    if (textBlock !== void 0 || visible !== "") {
      blockCount += 1;
      yield { type: "block-end", index: textBlock?.index ?? nextIndex, block: { type: "text", text: visible } };
    }
    if (reasoningBlock !== void 0 && reasoningBlock.text.trim() !== "") {
      if (reasoningText !== "") {
        blockCount += 1;
        yield { type: "block-end", index: reasoningBlock.index, block: { type: "reasoning", text: reasoningText } };
      }
    }
    const droppedUnnamedCalls = [...toolCalls.values()].some((block) => !block.announced);
    const reason = loopDetected ? { kind: "max-tokens" } : finishReason === "length" || droppedUnnamedCalls && toolOrder.length === 0 ? { kind: "max-tokens" } : finishReason === "tool_calls" || toolOrder.length > 0 ? { kind: "tool-calls" } : { kind: "stop" };
    yield { type: "finish", reason: resolveEmptyResponseReason(reason, blockCount) };
  }
  /**
   * 查询某个会话的 CodeArts 并发队列状态。该端点
   * 与 chat API 一样使用 AK/SK 签名；GET 不携带请求体，因此无 content-type。
   * @param credential - 用于签名请求的 AK/SK/SecurityToken。
   * @param model - 模型 id，作为 `model` 查询参数回传。
   * @param signal - 状态请求的取消信号。
   * @returns 解析后的排队状态，或当端点不可达
   *   或返回无法识别的载荷时返回 `undefined`。
   */
  async queryQueueStatus(credential, model, signal) {
    const url = `${QUEUE_STATUS_BASE}?model=${encodeURIComponent(model)}&task_id=${encodeURIComponent(this.sessionId)}`;
    const signed = await signRequestHuawei(
      credential.access_key_id,
      credential.secret_access_key,
      credential.security_token,
      "GET",
      url,
      new Uint8Array()
    );
    const headers = new Headers();
    signed.forEach((value, key) => {
      if (key !== "content-type") headers.set(key, value);
    });
    headers.set("x-snap-traceid", crypto.randomUUID());
    headers.set("Agent-Type", "INFERHUB_AGENT");
    headers.set("X-Language", "en");
    let response;
    try {
      response = await this.fetchImpl(url, { method: "GET", headers, signal });
    } catch {
      return void 0;
    }
    if (response.status !== 200) return void 0;
    let body;
    try {
      body = await response.json();
    } catch {
      return void 0;
    }
    const status = body.status;
    if (status !== "waiting" && status !== "working" && status !== "error" && status !== "queue_full") return void 0;
    return {
      status,
      queuePosition: Number(body.queue_position ?? -1),
      message: typeof body.message === "string" ? body.message : ""
    };
  }
}
function registerCodeArtsLlm(ctx, options) {
  ctx.llm.registerConfigurableProviders([
    {
      provider: PROVIDER,
      displayName: "CodeArts Agent",
      // 0.1.7 起 settings 命名空间只能是 profile 条目 id（见 settingsNamespaceFor）。
      settingsNs: settingsNamespaceFor(ctx, "llm-codearts"),
      settingsPath: []
    }
  ]);
  const adapter = new CodeArtsAdapter(options);
  ctx.llm.registerAdapter([PROVIDER], adapter);
  return adapter;
}
const RATE_LIMIT_BUSINESS_CODE = 6004;
const RATE_LIMIT_PATTERN = /频率限制|频率超出|使用量已超出|重置|rate.?limit|frequency limit|usage exceeds|too many requests/i;
function hasRateLimitBusinessCode(body) {
  try {
    const data = JSON.parse(body);
    const code = data.code;
    return code === RATE_LIMIT_BUSINESS_CODE || code === String(RATE_LIMIT_BUSINESS_CODE);
  } catch {
    return false;
  }
}
function isRateLimited(body) {
  return hasRateLimitBusinessCode(body) || RATE_LIMIT_PATTERN.test(body);
}
const RESET_TIME_PATTERN = /(?:将在|reset at)\s+([\d-]+\s+[\d:]+)\s+(UTC[+-]\d+(?::\d+)?)/i;
function parseRateLimitError(body, currentModel) {
  try {
    const data = JSON.parse(body);
    const msg = typeof data.msg === "string" ? data.msg : "";
    const resetMatch = RESET_TIME_PATTERN.exec(msg);
    if (resetMatch) {
      const resetMs = Date.parse(`${resetMatch[1]} ${resetMatch[2]}`);
      if (!Number.isNaN(resetMs)) {
        return { modelId: currentModel, resetTimeMs: resetMs };
      }
    }
    if (isRateLimited(body)) {
      return { modelId: currentModel, resetTimeMs: Date.now() + 36e5 };
    }
    return null;
  } catch {
    return null;
  }
}
export {
  CHAT_API_BASE,
  CodeArtsAdapter,
  PROVIDER,
  QUEUE_STATUS_BASE,
  isRateLimited,
  parseRateLimitError,
  registerCodeArtsLlm,
  serializeMessages
};
