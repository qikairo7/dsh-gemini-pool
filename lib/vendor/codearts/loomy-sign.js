import { createHash, createHmac, randomUUID } from "node:crypto";
function loomyContentMd5(body) {
  if (body.length === 0) return "";
  return createHash("md5").update(body, "utf8").digest("base64");
}
function escapeRfc3986(value) {
  return encodeURIComponent(value).replace(/!/g, "%21").replace(/'/g, "%27").replace(/\(/g, "%28").replace(/\)/g, "%29").replace(/\*/g, "%2A");
}
function buildEscapedPath(rawPath) {
  let clean = rawPath.startsWith("/") ? rawPath : `/${rawPath}`;
  if (clean.length > 1 && clean.endsWith("/")) clean = clean.slice(0, -1);
  return clean.split("/").map((seg) => seg.length > 0 ? escapeRfc3986(seg) : "").join("/");
}
function buildEscapedQueryString(queryParams) {
  if (queryParams === void 0) return "";
  const entries = Object.entries(queryParams);
  if (entries.length === 0) return "";
  return entries.map(([key, value]) => `${escapeRfc3986(key)}=${value === null || value === void 0 ? "" : escapeRfc3986(String(value))}`).join("&");
}
function buildLoomySigningString(options) {
  const method = options.method.toUpperCase();
  const escapedPath = buildEscapedPath(options.path);
  const escapedQuery = buildEscapedQueryString(options.queryParams);
  const body = options.body ?? "";
  const md5 = loomyContentMd5(body);
  const contentType = options.contentType ?? "";
  const signedHeaders = "";
  const canonicalizedHeaders = "";
  return [
    method,
    escapedPath,
    escapedQuery,
    md5,
    contentType,
    options.date,
    options.nonce,
    signedHeaders,
    canonicalizedHeaders
  ].join("\n");
}
function loomyAuthHeaders(options) {
  const date = (/* @__PURE__ */ new Date()).toUTCString();
  const nonce = randomUUID();
  const contentType = options.contentType ?? "application/json";
  const body = options.body ?? "";
  const stringToSign = buildLoomySigningString({ ...options, contentType, body, date, nonce });
  const signature = createHmac("sha1", options.accessKeySecret).update(stringToSign, "utf8").digest("base64");
  const headers = {
    Authorization: `account ${options.accessKeyId}:${signature}`,
    Date: date,
    Nonce: nonce,
    "Content-Type": contentType
  };
  const md5 = loomyContentMd5(body);
  if (md5.length > 0) headers["Content-MD5"] = md5;
  return headers;
}
export {
  buildLoomySigningString,
  loomyAuthHeaders,
  loomyContentMd5
};
