import { LlmError } from "@deepseek-ai/dsh-llm";
function innerTextOf(payload) {
  let envelope;
  try {
    envelope = JSON.parse(payload);
  } catch {
    return null;
  }
  if (envelope.body === void 0) return null;
  return typeof envelope.body === "string" ? envelope.body : JSON.stringify(envelope.body);
}
function unwrapQoderEnvelopePayload(payload) {
  const inner = innerTextOf(payload);
  if (inner === null) return null;
  return inner;
}
function unwrapQoderEnvelopeStream(response, label) {
  const upstream = response.body;
  if (upstream === null) {
    throw new LlmError(`${label}: \u54CD\u5E94\u6CA1\u6709 body`, "SERVER");
  }
  const decoder = new TextDecoder("utf-8");
  const encoder = new TextEncoder();
  let buffer = "";
  const transform = new TransformStream({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      let newline;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (line === "") {
          controller.enqueue(encoder.encode("\n"));
          continue;
        }
        if (!line.startsWith("data:")) {
          controller.enqueue(encoder.encode(`${line}
`));
          continue;
        }
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") {
          controller.enqueue(encoder.encode("data: [DONE]\n"));
          continue;
        }
        const inner = innerTextOf(payload);
        if (inner === null) {
          controller.enqueue(encoder.encode(`data: ${payload}
`));
          continue;
        }
        if (!inner.includes('"choices"') && !inner.includes("[DONE]")) {
          let code = "";
          let message = inner;
          try {
            const parsed = JSON.parse(inner);
            if (typeof parsed.code === "string") code = parsed.code;
            if (typeof parsed.message === "string") message = parsed.message;
          } catch {
          }
          const detail = code ? ` (${code})` : "";
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ error: { message: `${message}${detail}` } })}
`)
          );
          continue;
        }
        controller.enqueue(encoder.encode(`data: ${inner}
`));
      }
    },
    flush(controller) {
      const rest = buffer.trim();
      if (rest.length > 0) {
        const inner = rest.startsWith("data:") ? innerTextOf(rest.slice(5).trim()) : null;
        if (inner !== null) controller.enqueue(encoder.encode(`data: ${inner}
`));
      }
    }
  });
  return new Response(upstream.pipeThrough(transform), {
    status: response.status,
    statusText: response.statusText,
    headers: { "Content-Type": "text/event-stream" }
  });
}
export {
  unwrapQoderEnvelopePayload,
  unwrapQoderEnvelopeStream
};
