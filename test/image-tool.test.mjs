import assert from "node:assert/strict";
import test from "node:test";

import { createImageGenerateTool } from "../lib/image-tool.js";

test("image tool render gets its fields from the second argument (arguments, value)", () => {
  const tool = createImageGenerateTool({}, async () => ({ base64: "unused", accountEmail: "unused" }));
  const value = {
    path: "assets/images/hero.png",
    absolutePath: "/tmp/project/assets/images/hero.png",
    filename: "hero.png",
    prompt: "a hero banner",
    markdown: "![hero.png](assets/images/hero.png)",
  };
  // The host calls render(exec.arguments, value): output fields come from the
  // second argument, the tool-call arguments are the first.
  const rendered = tool.output.render({ prompt: "a hero banner" }, value);
  assert.equal(rendered.length, 1);
  assert.equal(rendered[0].type, "text");
  assert.ok(rendered[0].text.includes("assets/images/hero.png"));
  assert.ok(rendered[0].text.includes("![hero.png](assets/images/hero.png)"));
  assert.ok(!rendered[0].text.includes("undefined"));
});
