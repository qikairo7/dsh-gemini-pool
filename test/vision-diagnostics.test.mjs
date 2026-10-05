import assert from "node:assert/strict";
import test from "node:test";

import { doctorText, registerWebApi } from "../lib/index.js";

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

// The README's troubleshooting section sends users to a real callable entry:
// GET /antigravity/api/doctor returns the doctor text verbatim. This route
// was a documentation promise without an implementation until Refs #7.
test("web api registers GET /antigravity/api/doctor returning the doctor text", async () => {
  let route;
  const webCtx = {
    effect: (fn) => {
      fn();
      return () => {};
    },
    webServer: { register: (captured) => (route = captured) },
  };
  const ctx = { inject: (deps, cb) => cb(webCtx) };
  registerWebApi(ctx, {}, {});

  assert.ok(route, "registerWebApi must register a route");
  assert.equal(route.kind, "prefix");
  assert.equal(route.path, "/antigravity/api");

  const response = {
    statusCode: 0,
    writeHead(code, headers) {
      this.statusCode = code;
      this.headers = headers;
    },
    end(body) {
      this.body = body;
    },
  };
  await route.handler({ method: "GET", url: "/antigravity/api/doctor" }, response);

  assert.equal(response.statusCode, 200);
  assert.match(response.headers["content-type"], /application\/json/);
  const payload = JSON.parse(response.body);
  assert.equal(payload.ok, true);
  for (const line of ["visionEnabled=", "visionBridge=", "visionShim="]) {
    assert.ok(payload.value.includes(line), `doctor payload must include "${line}"`);
  }

  // Read-only fence: non-GET hits the method guard, no side effects.
  const rejected = { statusCode: 0, headers: {}, body: "" };
  Object.assign(rejected, {
    writeHead(code, headers) {
      this.statusCode = code;
      this.headers = headers;
    },
    end(body) {
      this.body = body;
    },
  });
  await route.handler({ method: "POST", url: "/antigravity/api/doctor" }, rejected);
  assert.equal(rejected.statusCode, 405);
  assert.equal(JSON.parse(rejected.body).error, "method-not-allowed");
});
