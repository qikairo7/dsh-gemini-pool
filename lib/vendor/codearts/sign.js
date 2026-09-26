async function sha256Hex(data) {
  const hash = await crypto.subtle.digest("SHA-256", data.slice().buffer);
  return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function hmacSha256Hex(key, data) {
  const cryptoKey = await crypto.subtle.importKey("raw", key.slice().buffer, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, data.slice().buffer);
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
function buildCanonicalRequest(method, uri, query, headers, payloadHash) {
  const signedHeaders = [];
  headers.forEach((_, k) => signedHeaders.push(k));
  signedHeaders.sort();
  const headerLines = signedHeaders.map((k) => `${k}:${headers.get(k) ?? ""}`);
  return [method, uri, query, headerLines.join("\n"), "", signedHeaders.join(";"), payloadHash].join("\n");
}
async function signRequestHuawei(ak, sk, securityToken, method, urlStr, body, extraHeaders) {
  const url = new URL(urlStr);
  let uri = url.pathname;
  if (!uri.endsWith("/")) uri += "/";
  const query = url.search.slice(1);
  const dateStamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const payloadHash = await sha256Hex(body);
  const headers = /* @__PURE__ */ new Map();
  headers.set("host", url.host);
  headers.set("x-sdk-date", dateStamp);
  headers.set("x-sdk-content-sha256", payloadHash);
  headers.set("x-security-token", securityToken);
  if (extraHeaders !== void 0) {
    for (const [key, value] of Object.entries(extraHeaders)) headers.set(key, value);
  }
  if (method.toUpperCase() !== "GET") headers.set("content-type", "application/json");
  const signedHeaders = [];
  headers.forEach((_, k) => signedHeaders.push(k));
  signedHeaders.sort();
  const canonicalRequest = buildCanonicalRequest(method, uri, query, headers, payloadHash);
  const canonicalHash = await sha256Hex(new TextEncoder().encode(canonicalRequest));
  const stringToSign = `SDK-HMAC-SHA256
${dateStamp}
${canonicalHash}`;
  const signature = await hmacSha256Hex(new TextEncoder().encode(sk), new TextEncoder().encode(stringToSign));
  headers.set("Authorization", `SDK-HMAC-SHA256 Access=${ak},SignedHeaders=${signedHeaders.join(";")},Signature=${signature}`);
  return headers;
}
export {
  buildCanonicalRequest,
  hmacSha256Hex,
  sha256Hex,
  signRequestHuawei
};
