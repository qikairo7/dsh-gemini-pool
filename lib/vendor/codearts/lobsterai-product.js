const LOBSTERAI_API_BASE = "https://lobsterai-server.youdao.com";
const LOBSTERAI_PORTAL_BASE = "https://lobsterai.youdao.com";
const LOBSTERAI_CLIENT_VERSION_API = "https://api-overmind.youdao.com/openapi/get/luna/hardware/lobsterai/prod/update";
const LOBSTERAI_FALLBACK_CLIENT_VERSION = "2026.9.4";
const LOBSTERAI_CLIENT_CAPABILITIES = "kimi-k3-agentic-v1,thinking-level-control-v1";
const LOBSTERAI_USER_AGENT = "LobsterAI/0.1.0";
const LOBSTERAI_FALLBACK_MODELS = [
  { id: "deepseek-v4-flash", name: "deepseek-v4-flash", contextWindow: 131072 },
  { id: "deepseek-v4-pro", name: "deepseek-v4-pro", contextWindow: 131072 },
  { id: "MiniMax-M3", name: "MiniMax-M3", contextWindow: 131072 },
  { id: "MiniMax-M2.7", name: "MiniMax-M2.7", contextWindow: 131072 },
  { id: "qwen3.7-max", name: "qwen3.7-max", contextWindow: 131072 },
  { id: "qwen3.7-plus", name: "qwen3.7-plus", contextWindow: 131072 },
  { id: "qwen3.6-plus", name: "qwen3.6-plus", contextWindow: 131072 },
  { id: "qwen3.5-plus-2026-04-20", name: "qwen3.5-plus-2026-04-20", contextWindow: 131072 },
  { id: "kimi-k2.7-code", name: "kimi-k2.7-code", contextWindow: 131072 },
  { id: "kimi-k2.7-code-highspeed", name: "kimi-k2.7-code-highspeed", contextWindow: 131072 },
  { id: "kimi-k2.6", name: "kimi-k2.6", contextWindow: 131072 },
  { id: "kimi-k2.5", name: "kimi-k2.5", contextWindow: 131072 },
  { id: "doubao-seed-2-1-pro-260628", name: "doubao-seed-2-1-pro-260628", contextWindow: 131072 },
  { id: "doubao-seed-2-1-turbo-260628", name: "doubao-seed-2-1-turbo-260628", contextWindow: 131072 },
  { id: "doubao-seed-2-0-code-preview-260215", name: "doubao-seed-2-0-code-preview-260215", contextWindow: 131072 },
  { id: "glm-5.2", name: "glm-5.2", contextWindow: 131072 },
  { id: "glm-5.1", name: "glm-5.1", contextWindow: 131072 },
  { id: "glm-5v-turbo", name: "glm-5v-turbo", contextWindow: 131072 },
  { id: "glm-5", name: "glm-5", contextWindow: 131072 }
];
const LOBSTERAI = {
  id: "lobsterai",
  displayName: "LobsterAI (\u6709\u9053)",
  portalBase: LOBSTERAI_PORTAL_BASE,
  apiBase: LOBSTERAI_API_BASE,
  clientVersionApi: LOBSTERAI_CLIENT_VERSION_API,
  fallbackClientVersion: LOBSTERAI_FALLBACK_CLIENT_VERSION,
  userAgent: LOBSTERAI_USER_AGENT,
  clientCapabilities: LOBSTERAI_CLIENT_CAPABILITIES,
  defaultCredentialRef: "LOBSTERAI_ACCESS_TOKEN",
  fallbackModels: LOBSTERAI_FALLBACK_MODELS
};
const ALL_LOBSTERAI_PRODUCTS = [LOBSTERAI];
function lobsteraiProductById(id) {
  return ALL_LOBSTERAI_PRODUCTS.find((product) => product.id === id);
}
export {
  ALL_LOBSTERAI_PRODUCTS,
  LOBSTERAI,
  LOBSTERAI_API_BASE,
  LOBSTERAI_CLIENT_CAPABILITIES,
  LOBSTERAI_CLIENT_VERSION_API,
  LOBSTERAI_FALLBACK_CLIENT_VERSION,
  LOBSTERAI_PORTAL_BASE,
  LOBSTERAI_USER_AGENT,
  lobsteraiProductById
};
