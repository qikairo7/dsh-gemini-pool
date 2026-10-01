import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { AccountPoolManager } from "../lib/pool.js";
import { createVisionTool, resolveImageInput } from "../lib/vision-tool.js";
import { requestVisionThroughPool, resolveVisionModelId } from "../lib/index.js";

const SSE = (...lines) => lines.map((l) => `data: ${l}\n\n`).join("");

function textChunk(text) {
  return JSON.stringify({
    response: {
      candidates: [{ content: { parts: [{ text }] } }],
    },
  });
}

function sseResponse(body, status = 200) {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body));
      controller.close();
    },
  });
  return new Response(stream, { status, headers: { "content-type": "text/event-stream" } });
}

function modelSettings(overrides = {}) {
  return {
    async read() {
      return {
        catalogModels: [],
        enabledModelIds: [],
        ...overrides,
      };
    },
  };
}

async function withStubbedFetch(handler, run) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => handler(String(url), init);
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

async function createTempManager() {
  const dir = await mkdtemp(join(tmpdir(), "gemini-pool-vision-"));
  const manager = new AccountPoolManager(join(dir, "accounts.json"), join(dir, "legacy.json"));
  await manager.init();
  return {
    manager,
    dir,
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

async function addAccount(manager, email) {
  await manager.addOrUpdateAccount({
    email,
    refresh: `refresh_${email}`,
    access: `access_${email}`,
    expires: Date.now() + 3600_000,
    projectId: "test-project",
  });
  return (await manager.getStatus()).accounts.find((a) => a.email === email).id;
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const HASH_PREFIX = "ab12cd34";
// 64-hex object name whose prefix is HASH_PREFIX.
const HASH_FULL = "ab12cd34" + "ef567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";

async function makeAttachmentsRoot() {
  const dir = await mkdtemp(join(tmpdir(), "vision-attachments-"));
  const bucket = join(dir, HASH_PREFIX.slice(0, 2));
  await mkdir(bucket, { recursive: true });
  const padding = Buffer.alloc(32, 7);
  await writeFile(join(bucket, HASH_FULL), Buffer.concat([PNG_MAGIC, padding]));
  return { root: dir, bucket, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test("resolveImageInput finds the unique attachment object for a hash prefix", async (t) => {
  const { root, cleanup } = await makeAttachmentsRoot();
  t.after(cleanup);
  const { base64, mimeType } = await resolveImageInput(HASH_PREFIX, { attachmentsRoot: root });
  assert.equal(mimeType, "image/png");
  const decoded = Buffer.from(base64, "base64");
  assert.deepEqual([...decoded.subarray(0, 8)], [...PNG_MAGIC]);
  // The sha256: form resolves to the same object.
  const viaSha = await resolveImageInput(`sha256:${HASH_PREFIX}`, { attachmentsRoot: root });
  assert.equal(viaSha.base64, base64);
  // Lookup is case-insensitive on the prefix.
  const upper = await resolveImageInput(HASH_PREFIX.toUpperCase(), { attachmentsRoot: root });
  assert.equal(upper.base64, base64);
});

test("resolveImageInput rejects 0-hit and ambiguous hash prefixes with distinct errors", async (t) => {
  const { root, bucket, cleanup } = await makeAttachmentsRoot();
  t.after(cleanup);
  await assert.rejects(
    () => resolveImageInput("ffffffff", { attachmentsRoot: root }),
    /No attachment .*ffffffff/i,
  );
  // A second object sharing the prefix makes the lookup ambiguous.
  await writeFile(join(bucket, HASH_FULL.slice(0, 16) + "99"), Buffer.from("x"));
  await assert.rejects(
    () => resolveImageInput(HASH_PREFIX, { attachmentsRoot: root }),
    /ambiguous/i,
  );
});

test("resolveImageInput parses data: URLs into mime type and base64 payload", async () => {
  const { base64, mimeType } = await resolveImageInput("data:image/webp;base64,QUJD");
  assert.equal(mimeType, "image/webp");
  assert.equal(Buffer.from(base64, "base64").toString(), "ABC");
  await assert.rejects(() => resolveImageInput("data:image/webp,QUJD"), /Invalid data: URL/);
});

test("resolveImageInput reads local files via absolute and cwd-relative paths", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "vision-file-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "shot.png");
  await writeFile(file, PNG_MAGIC);
  const absolute = await resolveImageInput(file, { attachmentsRoot: "unused" });
  assert.equal(absolute.mimeType, "image/png");
  await assert.rejects(() => resolveImageInput(join(dir, "missing.png"), { attachmentsRoot: "unused" }), /not found/i);
  // A genuine cwd-relative reference (fixture lives under test/).
  const localDir = await mkdtemp(join(process.cwd(), "test", "vision-tmp-"));
  t.after(() => rm(localDir, { recursive: true, force: true }));
  const localFile = join(localDir, "photo.jpg");
  await writeFile(localFile, Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
  const relResult = await resolveImageInput(relative(process.cwd(), localFile), { attachmentsRoot: "unused" });
  assert.equal(relResult.mimeType, "image/jpeg");
});

test("resolveImageInput refuses http(s) URLs", async () => {
  await assert.rejects(
    () => resolveImageInput("https://example.com/cat.png", { attachmentsRoot: "unused" }),
    /http\(s\) URLs are not supported/i,
  );
  await assert.rejects(
    () => resolveImageInput("http://localhost/secret", { attachmentsRoot: "unused" }),
    /http\(s\) URLs are not supported/i,
  );
});

test("resolveImageInput rejects images above the 10 MiB byte limit", async () => {
  const tooBig = Buffer.alloc(10 * 1024 * 1024 + 1, 1).toString("base64");
  await assert.rejects(
    () => resolveImageInput(`data:image/png;base64,${tooBig}`),
    /exceeds size limit/i,
  );
});

test("vision tool execute resolves the image, calls the pool, and renders text", async (t) => {
  const dataUrl = "data:image/png;base64," + PNG_MAGIC.toString("base64");
  const calls = [];
  const tool = createVisionTool({}, async (base64, mimeType, prompt) => {
    calls.push({ base64, mimeType, prompt });
    return { text: "A tiny PNG with padding bytes.", accountEmail: "vision@example.com" };
  });
  assert.equal(tool.name, "antigravity_read_image");

  const output = await tool.execute({ image: dataUrl });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].mimeType, "image/png");
  assert.equal(calls[0].base64, PNG_MAGIC.toString("base64"));
  assert.ok(calls[0].prompt.includes("Describe this image in detail"));
  assert.deepEqual(output, {
    description: "A tiny PNG with padding bytes.",
    image: dataUrl,
    account: "vision@example.com",
  });
  // The host calls render(arguments, value): fields come from the second one.
  const rendered = tool.output.render({ image: output.image }, output);
  assert.equal(rendered.length, 1);
  assert.equal(rendered[0].type, "text");
  assert.ok(rendered[0].text.includes("A tiny PNG with padding bytes."));
  assert.ok(rendered[0].text.includes("vision@example.com"));

  // Empty image argument is rejected before any IO.
  await assert.rejects(() => tool.execute({ image: "  " }), /image must be/);
  // An explicit prompt is forwarded verbatim (file path input exercises the
  // extension-based mime mapping).
  const dir = await mkdtemp(join(tmpdir(), "vision-execute-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "clip.webp");
  await writeFile(file, Buffer.from("RIFF"));
  await tool.execute({ image: file, prompt: "What is this?" });
  assert.equal(calls[1].prompt, "What is this?");
  assert.equal(calls[1].mimeType, "image/webp");
});

test("vision tool render gets its fields from the second argument (arguments, value)", () => {
  const tool = createVisionTool({}, async () => ({ text: "unused", accountEmail: "unused" }));
  const rendered = tool.output.render(
    { image: "ab12cd34" },
    { description: "A red square on white.", image: "ab12cd34", account: "acc@example.com" },
  );
  assert.equal(rendered.length, 1);
  assert.equal(rendered[0].type, "text");
  assert.ok(rendered[0].text.includes("A red square on white."));
  assert.ok(rendered[0].text.includes("acc@example.com"));
  assert.ok(!rendered[0].text.includes("undefined"));
});

test("requestVisionThroughPool collects text parts from the pool SSE stream", async (t) => {
  const { manager, cleanup } = await createTempManager();
  t.after(cleanup);
  await addAccount(manager, "visionpool@example.com");

  let seenBody = null;
  await withStubbedFetch(
    async (url, init) => {
      if (String(url).includes("fetchAvailableModels")) {
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      }
      seenBody = JSON.parse(String(init?.body || "{}"));
      const inlineChunk = JSON.stringify({
        response: { candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: "aGk=" } }] } }] },
      });
      return sseResponse(SSE(textChunk("It is "), inlineChunk, textChunk("a red square.")));
    },
    async () => {
      const result = await requestVisionThroughPool(
        PNG_MAGIC.toString("base64"),
        "image/png",
        "What is in this image?",
        manager,
        modelSettings(),
      );
      assert.equal(result.text, "It is a red square.");
      assert.equal(result.accountEmail, "visionpool@example.com");
    },
  );

  // The image rode along as an inlineData part next to the prompt text.
  const parts = seenBody?.request?.contents?.[0]?.parts || [];
  assert.ok(parts.some((p) => p.text === "What is in this image?"));
  assert.ok(
    parts.some((p) => p.inlineData?.mimeType === "image/png" && p.inlineData?.data === PNG_MAGIC.toString("base64")),
  );
});

test("resolveVisionModelId prefers visionModel, then a non-image-gen gemini, then the fallback", async (t) => {
  const { manager, cleanup } = await createTempManager();
  t.after(cleanup);

  const catalog = [
    { id: "claude-sonnet-4-6", inputModalities: ["text", "image"] },
    { id: "gemini-3.1-flash-image", inputModalities: ["text", "image"] },
    { id: "gemini-2.5-pro", inputModalities: ["text", "image"] },
    { id: "gemini-3.6-flash", inputModalities: ["text", "image"] },
    { id: "gpt-oss-120b", inputModalities: ["text"] },
  ];
  // gemini-3.6-flash stays catalogued but disabled, so the auto pick has
  // exactly one viable candidate regardless of catalog sort order.
  const settings = {
    catalogModels: catalog,
    enabledModelIds: catalog.filter((m) => m.id !== "gemini-3.6-flash").map((m) => m.id),
  };

  // Auto pick: claude is not gemini, the image-gen model is excluded by suffix.
  assert.equal(resolveVisionModelId(manager, settings), "gemini-2.5-pro");

  // A configured visionModel that exists in the catalog wins.
  await manager.updateConfig({ visionModel: "gemini-3.6-flash" });
  assert.equal(resolveVisionModelId(manager, settings), "gemini-3.6-flash");

  // A visionModel outside the catalog is ignored.
  await manager.updateConfig({ visionModel: "not-in-catalog" });
  assert.equal(resolveVisionModelId(manager, settings), "gemini-2.5-pro");

  // Nothing matches -> documented fallback.
  const textOnly = { catalogModels: [{ id: "gpt-oss-120b", inputModalities: ["text"] }], enabledModelIds: ["gpt-oss-120b"] };
  assert.equal(resolveVisionModelId(manager, textOnly), "gemini-3.6-flash");
});
