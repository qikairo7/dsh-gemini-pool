/**
 * Vision bridge: rewrites image blocks into pool-generated text descriptions
 * on the llm/stream waterfall, giving text-only models seamless vision.
 *
 * The bridge runs before the host projects image placeholders, so a
 * text-only model reads the description directly instead of a placeholder.
 * Descriptions are cached per image for the process lifetime (session
 * history resends the same image every turn); any failure keeps the original
 * image block so the host's placeholder path still applies (fail-open).
 */
import { createHash } from "node:crypto";
import { resolveImageInput } from "./vision-tool.js";

const ATTACHMENT_ID_RE = /^(?:sha256:)?([a-fA-F0-9]{64})$/i;
const DATA_URL_RE = /^data:([^;,]+);base64,(.*)$/s;

function sha256Hex(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function asString(value) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function hasImageBlock(messages) {
  return (
    Array.isArray(messages) &&
    messages.some(
      (message) =>
        Array.isArray(message?.content) && message.content.some((block) => block?.type === "image"),
    )
  );
}

/**
 * Extract the image source behind an image block. Returns
 * { cacheKey, traceId, mimeType, getBase64 } or null when the block carries
 * no attachment id and no inline data.
 */
function imageSourceOf(block, resolveImage) {
  const attachment = block.attachment;
  const attachmentId = attachment ? asString(attachment.attachmentId) : undefined;
  const idMatch = attachmentId ? ATTACHMENT_ID_RE.exec(attachmentId) : null;
  if (idMatch) {
    const hex = idMatch[1].toLowerCase();
    return {
      cacheKey: hex,
      traceId: `sha256:${hex}`,
      mimeType: asString(attachment.mediaType) || asString(block.mimeType) || asString(block.mediaType),
      getBase64: async () => (await resolveImage(idMatch[0])).base64,
      getResolvedMimeType: async () => (await resolveImage(idMatch[0])).mimeType,
    };
  }

  const source = block.source;
  const raw =
    asString(block.data) ||
    asString(block.base64) ||
    (source ? asString(source.data) || asString(source.base64) : undefined);
  if (!raw) return null;

  const dataUrlMatch = DATA_URL_RE.exec(raw);
  if (dataUrlMatch) {
    const digest = sha256Hex(Buffer.from(dataUrlMatch[2], "base64"));
    return {
      cacheKey: digest,
      traceId: `sha256:${digest}`,
      mimeType: asString(block.mimeType) || asString(block.mediaType) || dataUrlMatch[1],
      getBase64: async () => dataUrlMatch[2],
    };
  }

  const digest = sha256Hex(Buffer.from(raw, "base64"));
  return {
    cacheKey: digest,
    traceId: `sha256:${digest}`,
    mimeType: asString(block.mimeType) || asString(block.mediaType) || "image/png",
    getBase64: async () => raw,
  };
}

/**
 * Build the llm/stream waterfall handler. All knobs are injectable:
 * - isEnabled(): runtime switch (visionEnabled, flipped after pool init)
 * - isTextOnlyModel(provider, model): gate via the unwrapped resolveModelInfo
 * - describeImage(base64, mimeType): pool description call
 * - resolveImage: attachment/inline resolution (tests inject a stub)
 *
 * The handler is deliberately NOT async: the waterfall consumer iterates the
 * returned value as the stream, so it must be an async iterable itself, never
 * a promise of one. Sync exits hand the downstream generator back as-is; the
 * rewrite path awaits inside its own async generator and delegates with
 * yield*.
 */
export function createVisionBridge({ isEnabled, isTextOnlyModel, describeImage, resolveImage = resolveImageInput }) {
  // cacheKey -> Promise<description text>. Storing the promise deduplicates
  // concurrent turns; failures are evicted so a later turn retries.
  const descriptions = new Map();

  function describeCached(cacheKey, load) {
    let pending = descriptions.get(cacheKey);
    if (!pending) {
      pending = (async () => load())().catch((error) => {
        descriptions.delete(cacheKey);
        throw error;
      });
      descriptions.set(cacheKey, pending);
    }
    return pending;
  }

  // Returns the rewritten messages array, or null when nothing changed
  // (every description failed or no image block carried usable data).
  async function rewriteMessages(options) {
    let changed = false;
    const messages = await Promise.all(
      options.messages.map(async (message) => {
        if (!Array.isArray(message?.content) || !message.content.some((block) => block?.type === "image")) {
          return message;
        }
        const content = await Promise.all(
          message.content.map(async (block) => {
            if (!block || block.type !== "image") return block;
            const image = imageSourceOf(block, resolveImage);
            if (!image) return block;
            let text;
            try {
              text = await describeCached(image.cacheKey, async () =>
                describeImage(await image.getBase64(), image.mimeType || (await image.getResolvedMimeType?.())),
              );
            } catch (error) {
              console.warn(
                "[Antigravity Pool Vision] image description failed, keeping the original image block:",
                error?.message || error,
              );
              return block;
            }
            changed = true;
            return {
              type: "text",
              text:
                `[Image, described by Gemini from the Antigravity pool]\n${text}\n` +
                `(original attachment: ${image.traceId}; call antigravity_read_image with the 8-char hash prefix to look again)`,
            };
          }),
        );
        return { ...message, content };
      }),
    );
    return changed ? messages : null;
  }

  return function visionBridge(options, next) {
    try {
      // Sync exits return the downstream stream as-is: zero overhead when
      // the bridge is off or the request carries no images.
      if (!isEnabled?.()) return next();
      if (!hasImageBlock(options?.messages)) return next();
    } catch (error) {
      console.warn("[Antigravity Pool Vision] bridge error, passing the request through:", error?.message || error);
      return next();
    }
    return (async function* () {
      try {
        let textOnly = false;
        try {
          textOnly = await isTextOnlyModel(options.provider, options.model);
        } catch {
          // Unknown model state: leave the request alone.
        }
        if (!textOnly) {
          yield* next();
          return;
        }
        const messages = await rewriteMessages(options);
        if (!messages) {
          yield* next();
          return;
        }
        yield* next({ ...options, messages });
      } catch (error) {
        // Fail-open: a bridge failure must never block the LLM request.
        console.warn("[Antigravity Pool Vision] bridge error, passing the request through:", error?.message || error);
        yield* next();
      }
    })();
  };
}
