import assert from "node:assert/strict";
import test from "node:test";

import { installVisionAdmissionShim } from "../lib/index.js";

function llmWith(info) {
  return {
    resolveModelInfo: async () => info,
  };
}

test("shim adds image to inputModalities of text-only models, preserving other fields", async () => {
  const info = { name: "text-model", inputModalities: ["text"], contextWindow: 128000 };
  const llm = llmWith(info);
  const dispose = installVisionAdmissionShim(llm, true);

  const patched = await llm.resolveModelInfo("antigravity", "text-model");
  assert.deepEqual(patched.inputModalities, ["text", "image"]);
  // Untouched fields ride along.
  assert.equal(patched.name, "text-model");
  assert.equal(patched.contextWindow, 128000);

  dispose();
});

test("shim leaves vision-capable models untouched", async () => {
  const info = { name: "vision-model", inputModalities: ["text", "image"] };
  const llm = llmWith(info);
  const dispose = installVisionAdmissionShim(llm, true);

  const result = await llm.resolveModelInfo("antigravity", "vision-model");
  assert.deepEqual(result.inputModalities, ["text", "image"]);
  assert.equal(result, info);

  dispose();
});

test("shim leaves models with undefined inputModalities untouched", async () => {
  const info = { name: "unknown-modality" };
  const llm = llmWith(info);
  const dispose = installVisionAdmissionShim(llm, true);

  const result = await llm.resolveModelInfo("antigravity", "unknown-modality");
  assert.equal(result, info);
  assert.equal(result.inputModalities, undefined);

  dispose();
});

test("isEnabled=false installs nothing", async () => {
  const info = { name: "text-model", inputModalities: ["text"] };
  const llm = llmWith(info);
  const original = llm.resolveModelInfo;
  const dispose = installVisionAdmissionShim(llm, false);

  assert.equal(typeof dispose, "function");
  assert.equal(llm.resolveModelInfo, original);
  const result = await llm.resolveModelInfo("antigravity", "text-model");
  assert.deepEqual(result.inputModalities, ["text"]);
  dispose();
});

test("shim unwraps the cordis Symbol.for('cordis.original') target before wrapping", async () => {
  const info = { name: "text-model", inputModalities: ["text"] };
  const target = llmWith(info);
  const llm = { [Symbol.for("cordis.original")]: target };
  const dispose = installVisionAdmissionShim(llm, true);

  const patched = await target.resolveModelInfo("antigravity", "text-model");
  assert.deepEqual(patched.inputModalities, ["text", "image"]);

  dispose();
});

test("shim no-ops with a warning when resolveModelInfo is missing", async () => {
  const llm = {};
  const dispose = installVisionAdmissionShim(llm, true);
  assert.equal(typeof dispose, "function");
  assert.equal(llm.resolveModelInfo, undefined);
  dispose();
});

test("disposer restores the original resolveModelInfo behavior", async () => {
  const info = { name: "text-model", inputModalities: ["text"] };
  const llm = llmWith(info);
  const original = llm.resolveModelInfo;
  const dispose = installVisionAdmissionShim(llm, true);
  assert.notEqual(llm.resolveModelInfo, original);

  dispose();
  // The restored method no longer injects the image modality.
  const restored = await llm.resolveModelInfo("antigravity", "text-model");
  assert.deepEqual(restored.inputModalities, ["text"]);
  // Disposing twice stays harmless.
  dispose();
});
