import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AccountPoolManager } from "../lib/pool.js";
import { AntigravityPoolAdapter } from "../lib/index.js";

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
  const dir = await mkdtemp(join(tmpdir(), "gemini-pool-image-"));
  const manager = new AccountPoolManager(join(dir, "accounts.json"), join(dir, "legacy.json"));
  await manager.init();
  return {
    manager,
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

test("readImageRequest receives target with valid positive width, height, and maxBytes", async () => {
  const { manager, cleanup } = await createTempManager();
  try {
    await addAccount(manager, "imgtest@example.com");

    let receivedTarget = null;
    const fakeAttachments = {
      async readImageRequest(ref, target) {
        receivedTarget = target;
        return {
          mediaType: "image/png",
          data: Buffer.from("fake-png-bytes"),
          width: target.width,
          height: target.height,
        };
      },
    };

    const adapter = new AntigravityPoolAdapter(manager, modelSettings(), () => fakeAttachments);

    const messages = [
      {
        role: "user",
        content: [
          {
            type: "image",
            attachment: {
              attachmentId: "sha256:abc123def456",
              mediaType: "image/png",
              bytes: 302454,
              width: 1920,
              height: 1027,
              name: "test.png",
            },
          },
        ],
      },
    ];

    await withStubbedFetch(
      async () => sseResponse(SSE(textChunk("Got image"))),
      async () => {
        const chunks = [];
        for await (const chunk of adapter.stream({ model: "gemini-2.5-flash", messages })) {
          chunks.push(chunk);
        }
        assert.ok(chunks.length > 0);
      },
    );

    assert.ok(receivedTarget !== null, "readImageRequest should have been called");
    assert.ok(Number.isSafeInteger(receivedTarget.width) && receivedTarget.width > 0, "width must be positive int");
    assert.ok(Number.isSafeInteger(receivedTarget.height) && receivedTarget.height > 0, "height must be positive int");
    assert.ok(Number.isSafeInteger(receivedTarget.maxBytes) && receivedTarget.maxBytes > 0, "maxBytes must be positive int");
    assert.equal(receivedTarget.width, 1920);
    assert.equal(receivedTarget.height, 1027);
  } finally {
    await cleanup();
  }
});
