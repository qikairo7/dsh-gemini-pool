function isWrappedToolResult(block) {
  return typeof block === "object" && block !== null && block.type === "tool-result";
}
function isToolRoleMessage(message) {
  return message.role === "tool";
}
function detectMessageShape(messages) {
  let sawLegacy = false;
  for (const message of messages) {
    if (isToolRoleMessage(message)) return "tool-role";
    const content = message.content;
    if (Array.isArray(content) && content.some(isWrappedToolResult)) sawLegacy = true;
  }
  return sawLegacy ? "legacy" : "none";
}
function normalizeHarnessMessages(messages) {
  const shape = detectMessageShape(messages);
  const hasDeveloper = messages.some((message) => message.role === "developer");
  if (shape !== "tool-role" && !hasDeveloper) {
    return messages;
  }
  const normalized = [];
  for (const message of messages) {
    if (message.role === "developer") continue;
    if (!isToolRoleMessage(message)) {
      normalized.push(message);
      continue;
    }
    const source = message["source"];
    const sourceCallId = typeof source === "object" && source !== null ? source.callId : void 0;
    const toolCallId = message.toolCallId ?? sourceCallId;
    const block = {
      type: "tool-result",
      toolCallId,
      content: message.content
    };
    if (message.isError !== void 0) block.isError = message.isError;
    normalized.push({ role: "user", content: [block] });
  }
  return normalized;
}
export {
  detectMessageShape,
  normalizeHarnessMessages
};
