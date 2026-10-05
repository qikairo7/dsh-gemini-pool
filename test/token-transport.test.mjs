import assert from "node:assert/strict";
import test from "node:test";

import {
  proxyRemedy,
  tokenTransportError,
  requestToken,
} from "../lib/index.js";

test("proxyRemedy includes both CLI and DSH Desktop harness home paths", () => {
  const remedy = proxyRemedy();
  assert.match(remedy, /~\/\.dsh\/\.env/);
  assert.match(remedy, /%APPDATA%\\dsh-desktop\\harness\\\.env/);
  assert.match(remedy, /Library\/Application Support\/dsh-desktop\/harness\/\.env/);
});

test("tokenTransportError formats unreachable network error with proxy guidance", () => {
  const timeoutErr = new TypeError("fetch failed");
  timeoutErr.cause = { code: "UND_ERR_CONNECT_TIMEOUT", message: "Connect Timeout Error" };

  const formatted = tokenTransportError(timeoutErr);
  assert.match(formatted.message, /Cannot reach https:\/\/oauth2\.googleapis\.com\/token/);
  assert.match(formatted.message, /UND_ERR_CONNECT_TIMEOUT/);
  assert.match(formatted.message, /If this machine needs a proxy to reach Google/);
  assert.match(formatted.message, /dsh-desktop/);
  assert.equal(formatted.cause, timeoutErr);
});

test("tokenTransportError recognizes unreachable error codes and messages", () => {
  const markers = ["ENOTFOUND", "ECONNREFUSED", "ETIMEDOUT", "UND_ERR_SOCKET", "fetch failed"];
  for (const marker of markers) {
    const err = new Error(`Connection issue: ${marker}`);
    const formatted = tokenTransportError(err);
    assert.match(formatted.message, /Cannot reach https:\/\/oauth2\.googleapis\.com\/token/);
    assert.match(formatted.message, /If this machine needs a proxy to reach Google/);
  }
});

test("tokenTransportError formats non-unreachable error without proxy remedy", () => {
  const badArgErr = new Error("Invalid request parameter");
  const formatted = tokenTransportError(badArgErr);
  assert.match(formatted.message, /Token request to https:\/\/oauth2\.googleapis\.com\/token failed: Invalid request parameter/);
  assert.doesNotMatch(formatted.message, /If this machine needs a proxy to reach Google/);
});

test("requestToken surfaces reachable responses and enriches transport failures", async () => {
  const originalFetch = globalThis.fetch;
  try {
    // 1. Success case
    globalThis.fetch = async () => new Response("ok", { status: 200 });
    const res = await requestToken({ method: "POST" });
    assert.equal(res.status, 200);

    // 2. Transport failure case
    globalThis.fetch = async () => {
      const err = new TypeError("fetch failed");
      err.cause = { code: "UND_ERR_CONNECT_TIMEOUT", message: "timeout" };
      throw err;
    };
    await assert.rejects(
      async () => requestToken({ method: "POST" }),
      (err) => {
        assert.match(err.message, /Cannot reach https:\/\/oauth2\.googleapis\.com\/token/);
        assert.match(err.message, /proxy/i);
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
