import assert from "node:assert/strict";
import test from "node:test";

import { doctorText } from "../lib/index.js";

// Refs #7: /antigravity-doctor must surface the vision chain's assembly
// state — bridge listener registration, admission shim install result, and
// the live visionEnabled switch — so one doctor run tells whether the
// silent-failure candidates are even reachable in this process.
test("doctor output includes the vision assembly section", () => {
  const text = doctorText();
  assert.match(text, /^visionEnabled=/m);
  assert.match(text, /^visionBridge=/m);
  assert.match(text, /^visionShim=/m);
});

test("doctor vision lines report the pre-apply defaults before the plugin starts", () => {
  const lines = doctorText()
    .split("\n")
    .filter((line) => /^vision(Enabled|Bridge|Shim)=/.test(line));
  assert.equal(lines.length, 3);
  // Defaults before apply(): nothing registered, nothing installed yet.
  assert.ok(lines.some((line) => line === "visionBridge=unregistered"), `got: ${lines.join("; ")}`);
  assert.ok(lines.some((line) => line === "visionShim=pending"), `got: ${lines.join("; ")}`);
});
