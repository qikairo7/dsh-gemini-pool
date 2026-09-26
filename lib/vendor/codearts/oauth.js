import { createHash, randomBytes } from "node:crypto";
import { exportJWK, generateKeyPair, importJWK, SignJWT } from "jose";
const CLIENT_ID = "codearts-agent";
const REDIRECT_PATH = "/oauth/callback";
const STS_TOKEN_ENDPOINT = "https://sts.cn-north-4.myhuaweicloud.com/v1/oauth2/tokens";
const TOKEN_TIMEOUT_MS = 6e4;
const GRANT_AUTHORIZATION_CODE = "authorization_code";
const GRANT_REFRESH_TOKEN = "refresh_token";
function generatePkcePair() {
  const codeVerifier = randomBytes(48).toString("base64url");
  const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
  return { codeVerifier, codeChallenge };
}
async function generateDpopKeyPair() {
  const { privateKey, publicKey } = await generateKeyPair("ES256", { extractable: true, crv: "P-256" });
  return {
    privateKeyJwk: await exportJWK(privateKey),
    publicKeyJwk: await exportJWK(publicKey)
  };
}
async function signDpopJws(keyPair, htm, htu) {
  const key = await importJWK(keyPair.privateKeyJwk, "ES256", { extractable: false });
  const payload = {
    htm,
    htu,
    iat: Math.floor(Date.now() / 1e3),
    jti: randomBytes(32).toString("hex")
  };
  return new SignJWT(payload).setProtectedHeader({ alg: "ES256", typ: "dpop+jwt", jwk: keyPair.publicKeyJwk }).sign(key);
}
class RefreshTokenExpiredError extends Error {
  constructor(message) {
    super(message);
    this.name = "RefreshTokenExpiredError";
  }
}
async function requestToken(body, keyPair, fetcher = fetch) {
  const dpop = await signDpopJws(keyPair, "POST", STS_TOKEN_ENDPOINT);
  let response;
  try {
    response = await fetcher(STS_TOKEN_ENDPOINT, {
      method: "POST",
      headers: {
        DPoP: dpop,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams(body).toString(),
      signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS)
    });
  } catch (error) {
    throw new Error(`CodeArts token request network error: ${String(error)}`);
  }
  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }
  if (!response.ok || !data?.credentials) {
    const message = `CodeArts token request failed: ${response.status}${data ? ` ${JSON.stringify(data)}` : ""}`;
    const errorCode = String(data?.error_code ?? "");
    if (data?.error === "invalid_grant" || errorCode.includes("ExpiredRefreshToken") || errorCode.includes("InvalidDPoPHeader")) {
      throw new RefreshTokenExpiredError(message);
    }
    throw new Error(message);
  }
  return data;
}
async function exchangeAuthorizationCode(code, codeVerifier, port, keyPair, fetcher = fetch) {
  return requestToken({
    client_id: CLIENT_ID,
    code,
    code_verifier: codeVerifier,
    grant_type: GRANT_AUTHORIZATION_CODE,
    redirect_uri: `http://127.0.0.1:${port}${REDIRECT_PATH}`
  }, keyPair, fetcher);
}
async function exchangeRefreshToken(refreshToken, codeVerifier, keyPair, fetcher = fetch) {
  return requestToken({
    client_id: CLIENT_ID,
    code_verifier: codeVerifier,
    grant_type: GRANT_REFRESH_TOKEN,
    refresh_token: refreshToken
  }, keyPair, fetcher);
}
function credentialFromTokenResponse(token, pkce, keyPair) {
  const credentials = token.credentials ?? {};
  return {
    access_key_id: credentials.access_key_id ?? "",
    secret_access_key: credentials.secret_access_key ?? "",
    security_token: credentials.security_token ?? "",
    expires_at: credentials.expiration ?? "",
    refresh_token: token.refresh_token,
    code_verifier: pkce.codeVerifier,
    dpop_private_key_jwk: keyPair.privateKeyJwk
  };
}
function keyPairFromStoredJwk(jwk) {
  return {
    privateKeyJwk: jwk,
    publicKeyJwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y }
  };
}
export {
  CLIENT_ID,
  GRANT_AUTHORIZATION_CODE,
  GRANT_REFRESH_TOKEN,
  REDIRECT_PATH,
  RefreshTokenExpiredError,
  STS_TOKEN_ENDPOINT,
  TOKEN_TIMEOUT_MS,
  credentialFromTokenResponse,
  exchangeAuthorizationCode,
  exchangeRefreshToken,
  generateDpopKeyPair,
  generatePkcePair,
  keyPairFromStoredJwk,
  requestToken,
  signDpopJws
};
