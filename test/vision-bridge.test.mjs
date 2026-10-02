import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";

import { createVisionBridge } from "../lib/vision-bridge.js";

const HASH = "ab12cd34".repeat(8);
const ATTACHMENT_ID = `sha256:${HASH}`;

function sha256Hex(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function deepFreeze(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

// The llm/stream waterfall hands each handler's RETURN VALUE to the consumer
// as the stream: next() yields one chunk carrying whatever options reached
// the downstream middleware.
function makeNext(rootOptions) {
  const next = (override) => {
    next.calls.push(override);
    const generator = (async function* () {
      yield { forwarded: override ?? rootOptions, marker: "downstream" };
    })();
    next.generators.push(generator);
    return generator;
  };
  next.calls = [];
  next.generators = [];
  return next;
}

async function collect(iterable) {
  const chunks = [];
  for await (const chunk of iterable) chunks.push(chunk);
  return chunks;
}

// Untouched passthroughs call next() without an override (or with the
// original options) and the downstream sees that same options object.
async function assertPassedThrough(bridge, options) {
  const next = makeNext(options);
  const chunks = await collect(bridge(options, next));
  assert.equal(next.calls.length, 1);
  assert.ok(next.calls[0] === undefined || next.calls[0] === options, "next must carry the original options");
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].forwarded, options, "downstream must see the original options object");
  assert.equal(chunks[0].marker, "downstream");
}

function makeDeps({ textOnly = true, describe } = {}) {
  const resolveCalls = [];
  const describeCalls = [];
  const deps = {
    resolveCalls,
    describeCalls,
    isEnabled: () => true,
    isTextOnlyModel: async () => textOnly,
    resolveImage: async (ref) => {
      resolveCalls.push(ref);
      return { base64: "QUJD", mimeType: "image/png" };
    },
    describeImage: async (base64, mimeType) => {
      describeCalls.push({ base64, mimeType });
      return describe ? describe() : "A red square on white background.";
    },
  };
  deps.bridge = createVisionBridge(deps);
  return deps;
}

test("handler's return value is itself an async iterable (waterfall contract)", async () => {
  const { bridge } = makeDeps();
  // Sync passthrough branch: the downstream generator is handed back as-is,
  // not wrapped in a promise.
  const textOptions = {
    provider: "antigravity",
    model: "glm-5.3-flash",
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
  };
  const next1 = makeNext(textOptions);
  const direct = bridge(textOptions, next1);
  assert.equal(typeof direct?.[Symbol.asyncIterator], "function", "sync branch must return the generator itself");
  assert.equal(direct, next1.generators[0], "sync branch must pass the downstream stream through untouched");

  // Async rewrite branch: also an async iterable, not a promise of one.
  const imageOptions = {
    provider: "antigravity",
    model: "glm-5.3-flash",
    messages: [{ role: "user", content: [{ type: "image", attachment: { attachmentId: ATTACHMENT_ID } }] }],
  };
  const next2 = makeNext(imageOptions);
  const rewritten = bridge(imageOptions, next2);
  assert.equal(typeof rewritten?.[Symbol.asyncIterator], "function", "async branch must return an async generator");
  const chunks = await collect(rewritten);
  assert.equal(chunks[0].forwarded.messages[0].content[0].type, "text");
});

test("no image blocks -> next receives the original options untouched", async () => {
  const { bridge } = makeDeps();
  const options = {
    provider: "antigravity",
    model: "glm-5.3-flash",
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
  };
  await assertPassedThrough(bridge, options);
});

test("text-only model: image blocks are replaced with descriptions, input stays frozen-intact", async () => {
  const { bridge, resolveCalls, describeCalls } = makeDeps();
  const dataUrl = "data:image/png;base64,QUJD";
  const messages = deepFreeze([
    {
      role: "user",
      content: [
        { type: "text", text: "what do you see?" },
        { type: "image", attachment: { attachmentId: ATTACHMENT_ID, mediaType: "image/png" } },
      ],
    },
    {
      role: "user",
      content: [{ type: "image", data: dataUrl, mimeType: "image/png" }],
    },
  ]);
  const options = { provider: "antigravity", model: "glm-5.3-flash", messages };
  const next = makeNext(options);

  const chunks = await collect(bridge(options, next));
  assert.equal(next.calls.length, 1);
  const forwarded = next.calls[0];
  assert.notEqual(forwarded, options, "replaced messages must be forwarded as a new options object");
  assert.notEqual(forwarded.messages, messages);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].forwarded, forwarded);

  const [first, second] = forwarded.messages;
  const replacement = first.content[1];
  assert.equal(replacement.type, "text");
  assert.ok(replacement.text.includes("A red square on white background."));
  assert.ok(replacement.text.includes(`(original attachment: sha256:${HASH}`));
  assert.ok(replacement.text.includes("call antigravity_read_image with the 8-char hash prefix"));
  assert.equal(first.content[0].text, "what do you see?", "non-image blocks ride along unchanged");

  // Inline data: URL is decoded inside the bridge (no resolver round-trip).
  assert.equal(second.content[0].type, "text");
  assert.ok(second.content[0].text.includes("A red square on white background."));
  assert.ok(second.content[0].text.includes(`sha256:${sha256Hex(Buffer.from("ABC"))}`));

  assert.deepEqual(resolveCalls, [ATTACHMENT_ID]);
  assert.equal(describeCalls.length, 2);

  // The original deep-frozen input was never mutated.
  assert.equal(messages[0].content[1].type, "image");
  assert.equal(messages[1].content[0].type, "image");
});

test("vision-capable model -> images pass through untouched", async () => {
  const { bridge, describeCalls } = makeDeps({ textOnly: false });
  const options = {
    provider: "antigravity",
    model: "gemini-3.6-flash",
    messages: [
      { role: "user", content: [{ type: "image", attachment: { attachmentId: ATTACHMENT_ID } }] },
    ],
  };
  await assertPassedThrough(bridge, options);
  assert.equal(describeCalls.length, 0);
});

test("isTextOnlyModel throwing -> conservative passthrough", async () => {
  const deps = makeDeps();
  deps.isTextOnlyModel = async () => {
    throw new Error("resolver exploded");
  };
  const bridge = createVisionBridge(deps);
  const options = {
    provider: "antigravity",
    model: "glm-5.3-flash",
    messages: [
      { role: "user", content: [{ type: "image", attachment: { attachmentId: ATTACHMENT_ID } }] },
    ],
  };
  await assertPassedThrough(bridge, options);
  assert.equal(deps.describeCalls.length, 0);
});

test("same attachment id across turns describes only once (cache)", async () => {
  const { bridge, describeCalls } = makeDeps();
  const options = {
    provider: "antigravity",
    model: "glm-5.3-flash",
    messages: [
      { role: "user", content: [{ type: "image", attachment: { attachmentId: ATTACHMENT_ID } }] },
    ],
  };
  await collect(bridge(options, makeNext(options)));
  await collect(bridge(options, makeNext(options)));
  assert.equal(describeCalls.length, 1);
});

test("concurrent calls for the same image share one in-flight description", async () => {
  const gate = deferred();
  let describeCalls = 0;
  const deps = makeDeps();
  deps.describeImage = async (base64, mimeType) => {
    describeCalls += 1;
    return gate.promise.then(() => "late description");
  };
  const bridge = createVisionBridge(deps);
  const options = {
    provider: "antigravity",
    model: "glm-5.3-flash",
    messages: [
      { role: "user", content: [{ type: "image", attachment: { attachmentId: ATTACHMENT_ID } }] },
    ],
  };
  const first = collect(bridge(options, makeNext(options)));
  const second = collect(bridge(options, makeNext(options)));
  gate.resolve();
  await Promise.all([first, second]);
  assert.equal(describeCalls, 1);
});

test("describeImage rejecting -> fail-open: the original image block survives", async () => {
  let calls = 0;
  const deps = makeDeps();
  deps.describeImage = async () => {
    calls += 1;
    throw new Error("pool is down");
  };
  const bridge = createVisionBridge(deps);
  const imageBlock = { type: "image", attachment: { attachmentId: ATTACHMENT_ID } };
  const options = {
    provider: "antigravity",
    model: "glm-5.3-flash",
    messages: [{ role: "user", content: [{ type: "text", text: "look" }, imageBlock] }],
  };
  // Fail-open passthrough: no override, so the host keeps the original
  // options whose image block is untouched.
  await assertPassedThrough(bridge, options);
  assert.equal(options.messages[0].content[1].type, "image");
  assert.equal(options.messages[0].content[1], imageBlock);
  // The failed key was evicted: a later turn retries the description.
  await collect(bridge(options, makeNext(options)));
  assert.equal(calls, 2);
});

test("isEnabled false -> passthrough without consulting the model gate", async () => {
  const deps = makeDeps();
  let gateCalls = 0;
  deps.isEnabled = () => false;
  deps.isTextOnlyModel = async () => {
    gateCalls += 1;
    return true;
  };
  const bridge = createVisionBridge(deps);
  const options = {
    provider: "antigravity",
    model: "glm-5.3-flash",
    messages: [
      { role: "user", content: [{ type: "image", attachment: { attachmentId: ATTACHMENT_ID } }] },
    ],
  };
  await assertPassedThrough(bridge, options);
  assert.equal(gateCalls, 0);
  assert.equal(deps.describeCalls.length, 0);
});

// --- Decision-chain logging (Refs #7) ---------------------------------------
// The bridge must say what it decided on every async path so one reproduction
// tells which of the four candidate breakpoints (event not reaching the
// bridge / resolver unavailable / resolver error / describe failure) fired.
// No log lines at all means the handler was never entered with images.

function imageOptions(blocks = [{ type: "image", attachment: { attachmentId: ATTACHMENT_ID } }]) {
  return {
    provider: "antigravity",
    model: "glm-5.3-flash",
    messages: [{ role: "user", content: blocks }],
  };
}

function makeLoggingDeps(overrides = {}) {
  const lines = [];
  const deps = makeDeps(overrides.textOnly === undefined ? {} : { textOnly: overrides.textOnly });
  deps.log = (message) => lines.push(message);
  Object.assign(deps, { lines }, overrides.deps || {});
  return { bridge: createVisionBridge(deps), lines, deps };
}

test("logging: happy path baseline signature", async () => {
  const { bridge, lines } = makeLoggingDeps();
  const options = imageOptions([
    { type: "text", text: "what is this?" },
    { type: "image", attachment: { attachmentId: ATTACHMENT_ID } },
  ]);
  await collect(bridge(options, makeNext(options)));
  assert.equal(lines.length, 3, `expected request/gate/rewrote lines, got: ${JSON.stringify(lines)}`);
  assert.match(lines[0], /^request provider=antigravity model=glm-5\.3-flash images=1$/);
  assert.match(lines[1], /^model gate: textOnly=true$/);
  assert.match(lines[2], /^rewrote: 1 image block\(s\) replaced$/);
});

test("logging: textOnly=false -> not-text-only passthrough", async () => {
  const { bridge, lines } = makeLoggingDeps({ textOnly: false });
  const options = imageOptions();
  await collect(bridge(options, makeNext(options)));
  assert.equal(lines.length, 3);
  assert.match(lines[2], /^passthrough: reason=not-text-only$/);
});

test("logging: gate resolver throwing -> resolve=error passthrough", async () => {
  const { lines } = makeLoggingDeps();
  const deps = makeDeps();
  deps.isTextOnlyModel = async () => {
    throw new Error("resolver exploded");
  };
  deps.log = (message) => lines.push(message);
  const bridge = createVisionBridge(deps);
  const options = imageOptions();
  await collect(bridge(options, makeNext(options)));
  assert.equal(lines.length, 3);
  assert.match(lines[1], /^model gate: resolve=error \(resolver exploded\)$/);
  assert.match(lines[2], /^passthrough: reason=gate-error$/);
});

test("logging: all descriptions failing -> all-describe-failed passthrough", async () => {
  const { lines } = makeLoggingDeps();
  const deps = makeDeps();
  deps.describeImage = async () => {
    throw new Error("pool is down");
  };
  deps.log = (message) => lines.push(message);
  const bridge = createVisionBridge(deps);
  const options = imageOptions();
  await collect(bridge(options, makeNext(options)));
  const passthrough = lines.find((l) => l.startsWith("passthrough:"));
  assert.match(passthrough, /^passthrough: reason=all-describe-failed \(1 failed\)$/);
});

test("logging: image blocks without usable source -> no-usable-source passthrough", async () => {
  const { bridge, lines } = makeLoggingDeps();
  // Width/height only: no attachmentId, no data — imageSourceOf cannot resolve it.
  const options = imageOptions([{ type: "image", width: 100, height: 50 }]);
  await collect(bridge(options, makeNext(options)));
  const passthrough = lines.find((l) => l.startsWith("passthrough:"));
  assert.match(passthrough, /^passthrough: reason=no-usable-source \(1 unresolved\)$/);
});

test("logging: no-image requests produce no log lines", async () => {
  const { bridge, lines } = makeLoggingDeps();
  const options = {
    provider: "antigravity",
    model: "glm-5.3-flash",
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
  };
  await collect(bridge(options, makeNext(options)));
  assert.equal(lines.length, 0);
});

test("logging: failure injections have pairwise-distinguishable readouts (Refs #7 red team)", async () => {
  const readouts = {};

  // Injection A — handler entered but gate says not text-only (resolver
  // unavailable in the assembled plugin reads exactly like this at the bridge
  // layer; the index-side resolver log disambiguates).
  {
    const { bridge, lines } = makeLoggingDeps({ textOnly: false });
    await collect(bridge(imageOptions(), makeNext(imageOptions())));
    readouts.notTextOnly = lines.join("|");
  }
  // Injection B — resolver throws.
  {
    const { lines } = makeLoggingDeps();
    const deps = makeDeps();
    deps.isTextOnlyModel = async () => {
      throw new Error("boom");
    };
    deps.log = (m) => lines.push(m);
    const bridge = createVisionBridge(deps);
    await collect(bridge(imageOptions(), makeNext(imageOptions())));
    readouts.gateError = lines.join("|");
  }
  // Injection C — describe fails for every usable image.
  {
    const { lines } = makeLoggingDeps();
    const deps = makeDeps();
    deps.describeImage = async () => {
      throw new Error("pool is down");
    };
    deps.log = (m) => lines.push(m);
    const bridge = createVisionBridge(deps);
    await collect(bridge(imageOptions(), makeNext(imageOptions())));
    readouts.describeFailed = lines.join("|");
  }
  // Injection D — event never reaches the handler (or no image): no lines.
  {
    const { bridge, lines } = makeLoggingDeps();
    const options = {
      provider: "antigravity",
      model: "glm-5.3-flash",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    };
    await collect(bridge(options, makeNext(options)));
    readouts.eventMissed = lines.join("|");
  }

  const values = Object.values(readouts);
  assert.ok(values.every((v) => v.length > 0 || v === readouts.eventMissed));
  assert.equal(new Set(values).size, values.length, "all four readouts must be pairwise distinct");
  assert.equal(readouts.eventMissed, "", "missed event must read as zero lines");
});
