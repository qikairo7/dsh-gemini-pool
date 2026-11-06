import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCatalogFromRawModels,
  mergeCatalogModels,
  rawModelsFromAvailable,
  runtimeModelForEffort,
  splitRuntimeModelId,
} from "../lib/catalog.js";

function availableModels(entries) {
  const models = {};
  for (const [id, extra] of Object.entries(entries)) {
    models[id] = {
      displayName: extra.name || "",
      maxTokens: extra.maxTokens ?? 1048576,
      maxOutputTokens: extra.maxOutputTokens ?? 65536,
      supportsImages: extra.supportsImages ?? true,
      disabled: extra.disabled === true,
      quotaInfo: { remainingFraction: extra.remaining ?? 1, resetTime: "2026-11-01T00:00:00Z" },
      ...extra,
    };
  }
  return { models };
}

test("a free account without 3.8/3.7 never advertises them (issue #15/#16)", () => {
  const catalog = buildCatalogFromRawModels(
    rawModelsFromAvailable(
      availableModels({
        "gemini-3.6-flash-high": { name: "Gemini 3.6 Flash (High)" },
        "gemini-3.6-flash-medium": { name: "Gemini 3.6 Flash (Medium)" },
        "gemini-3.5-flash-lite": { name: "Gemini 3.5 Flash Lite" },
      }),
    ),
  );
  const ids = catalog.map((model) => model.id);
  assert.ok(ids.includes("gemini-3.6-flash"));
  assert.ok(ids.includes("gemini-3.5-flash-lite"));
  assert.equal(ids.includes("gemini-3.8-flash"), false);
  assert.equal(ids.includes("gemini-3.7-flash"), false);
  // No fabricated family quota row either.
  assert.equal(catalog.find((model) => model.id === "gemini-3.8-flash"), undefined);
});

test("3.8 level variants fold into one public model with a runtime map", () => {
  const catalog = buildCatalogFromRawModels(
    rawModelsFromAvailable(
      availableModels({
        "gemini-3.8-flash-low": { name: "Gemini 3.8 Flash (Low)" },
        "gemini-3.8-flash-medium": { name: "Gemini 3.8 Flash (Medium)" },
        "gemini-3.8-flash-high": { name: "Gemini 3.8 Flash (High)" },
        "gemini-3.8-flash-tiered": { remaining: 0.5 },
      }),
    ),
  );
  const model = catalog.find((entry) => entry.id === "gemini-3.8-flash");
  assert.ok(model);
  assert.equal(model.name, "Gemini 3.8 Flash");
  assert.deepEqual(model.reasoningEfforts, ["low", "medium", "high"]);
  assert.equal(runtimeModelForEffort(model, "off"), "gemini-3.8-flash-tiered");
  assert.equal(runtimeModelForEffort(model, "low"), "gemini-3.8-flash-low");
  assert.equal(runtimeModelForEffort(model, "high"), "gemini-3.8-flash-high");
  assert.equal(catalog.filter((entry) => entry.id.startsWith("gemini-3.8-flash")).length, 1);
});

test("Gemini 4 Argon is discovered from the live list (issue #17)", () => {
  const catalog = buildCatalogFromRawModels(
    rawModelsFromAvailable(
      availableModels({
        "gemini-4-argon-low": { name: "Gemini 4 Argon (Low)" },
        "gemini-4-argon-medium": { name: "Gemini 4 Argon (Medium)" },
        "gemini-4-argon-high": { name: "Gemini 4 Argon (High)" },
      }),
    ),
  );
  const model = catalog.find((entry) => entry.id === "gemini-4-argon");
  assert.ok(model);
  assert.equal(model.name, "Gemini 4 Argon");
  assert.deepEqual(model.reasoningEfforts, ["low", "medium", "high"]);
  assert.equal(runtimeModelForEffort(model, "medium"), "gemini-4-argon-medium");
});

test("disabled models are not offered (gemini-4-argon-disabled 404 guard)", () => {
  const catalog = buildCatalogFromRawModels(
    rawModelsFromAvailable(
      availableModels({
        "gemini-4-argon-disabled": { name: "Gemini 4 Argon", disabled: true },
        "gemini-3-flash": { name: "Gemini 3 Flash" },
      }),
    ),
  );
  assert.equal(catalog.some((model) => model.id.includes("argon")), false);
  assert.ok(catalog.some((model) => model.id === "gemini-3-flash"));
});

test("pool union keeps models available on only one account", () => {
  const accountA = buildCatalogFromRawModels(
    rawModelsFromAvailable(availableModels({ "gemini-3.8-flash-high": { name: "Gemini 3.8 Flash (High)" } })),
  );
  const accountB = buildCatalogFromRawModels(
    rawModelsFromAvailable(availableModels({ "gemini-4-argon-high": { name: "Gemini 4 Argon (High)" } })),
  );
  const union = mergeCatalogModels([accountA, accountB]);
  const ids = union.map((model) => model.id);
  assert.ok(ids.includes("gemini-3.8-flash"));
  assert.ok(ids.includes("gemini-4-argon"));
});

test("family splitting treats tiered as the family default", () => {
  assert.deepEqual(splitRuntimeModelId("gemini-3.8-flash-tiered"), {
    family: "gemini-3.8-flash",
    effort: "",
    tiered: true,
  });
  assert.deepEqual(splitRuntimeModelId("gemini-4-argon-medium"), {
    family: "gemini-4-argon",
    effort: "medium",
    tiered: false,
  });
});
