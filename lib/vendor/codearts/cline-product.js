const CLINE_FALLBACK_MODELS = [
  // ── 免费模型（远端 `free` 数组实测 2026-09-25，共 5 个）──
  // 这 5 个正是用户截图里的清单。
  {
    id: "stealth/space-bunny-alpha",
    name: "Space Bunny Alpha",
    contextWindow: 1e6,
    maxTokens: 524288,
    supportsImage: true,
    isFree: true,
    description: "Blazing-fast inference with 1M context"
  },
  {
    id: "cline-free/mimo-v2.6-flash",
    name: "MiMo-V2.6-Flash",
    contextWindow: 1048576,
    maxTokens: 131072,
    supportsImage: true,
    isFree: true,
    description: "Mixture-of-Experts architecture with 309B total parameters"
  },
  {
    id: "cline-free/deepseek-v4.1-flash",
    name: "DeepSeek V4.1 Flash",
    contextWindow: 1048576,
    maxTokens: 131072,
    supportsImage: true,
    isFree: true,
    description: "Fast and efficient with 1M context window"
  },
  {
    // ⚠️ 内嵌目录里**没有**这一条（只有远端 `free` 数组下发），元数据取自
    // 远端 description + 同名 `google/gemini-3.8-flash` 的目录实测值。
    //
    // ⚠️ **输出上限是 65536，不要照抄其它免费模型的 131072**（真实缺陷，
    // 用户报障 2026-09-25）：给该模型发 `max_tokens=131072` 会被上游的
    // vertex provider 以 400 拒绝 —— "has a maxOutputTokens value of 131072
    // but the supported range is from 1 (inclusive) to 65537 (exclusive)"，
    // 即上限就是 65536，与内嵌目录一致。
    id: "cline-free/gemini-3.8-flash",
    name: "Gemini 3.8 Flash",
    contextWindow: 1048576,
    maxTokens: 65536,
    supportsImage: true,
    isFree: true,
    description: "Google's most intelligent Flash model"
  },
  {
    id: "cline-free/muse-spark-1.3-contributor",
    name: "Muse Spark 1.3 Contributor",
    contextWindow: 1048576,
    maxTokens: 943718,
    supportsImage: true,
    isFree: true,
    description: "Meta\u2019s multimodal reasoning model for experimentation, learning, and early-stage agentic, multi-agent, and coding workflows."
  }
];
const CLINE_REASONING_EFFORTS = [
  { id: "none", name: "None" },
  { id: "low", name: "Low" },
  { id: "medium", name: "Medium" },
  { id: "high", name: "High" },
  { id: "max", name: "Extra" }
];
const CLINE_DEFAULT_REASONING_EFFORT = "high";
const CLINE = {
  id: "cline",
  displayName: "Cline",
  apiBase: "https://api.cline.bot",
  appBase: "https://app.cline.bot",
  workOsBase: "https://api.workos.com",
  workOsClientId: "client_01K3A541FN8TA3EPPHTD2325AR",
  clientHeaders: {
    "HTTP-Referer": "https://cline.bot",
    "X-Title": "Cline",
    "X-IS-MULTIROOT": "false",
    "X-CLIENT-TYPE": "cline-sdk"
  },
  tokenPrefix: "workos:",
  defaultCredentialRef: "CLINE_ACCESS_TOKEN",
  fallbackModels: CLINE_FALLBACK_MODELS
};
const ALL_CLINE_PRODUCTS = [CLINE];
function clineProductById(id) {
  return ALL_CLINE_PRODUCTS.find((product) => product.id === id);
}
const CLINE_DEVICE_AUTHORIZATION_PATH = "/user_management/authorize/device";
const CLINE_DEVICE_AUTHENTICATE_PATH = "/user_management/authenticate";
const CLINE_REGISTER_PATH = "/api/v1/auth/register";
const CLINE_REFRESH_PATH = "/api/v1/auth/refresh";
const CLINE_CHAT_PATH = "/api/v1/chat/completions";
const CLINE_MODELS_PATH = "/api/v1/models";
const CLINE_RECOMMENDED_MODELS_PATH = "/api/v1/ai/cline/recommended-models";
const CLINE_ME_PATH = "/api/v1/users/me";
export {
  ALL_CLINE_PRODUCTS,
  CLINE,
  CLINE_CHAT_PATH,
  CLINE_DEFAULT_REASONING_EFFORT,
  CLINE_DEVICE_AUTHENTICATE_PATH,
  CLINE_DEVICE_AUTHORIZATION_PATH,
  CLINE_ME_PATH,
  CLINE_MODELS_PATH,
  CLINE_REASONING_EFFORTS,
  CLINE_RECOMMENDED_MODELS_PATH,
  CLINE_REFRESH_PATH,
  CLINE_REGISTER_PATH,
  clineProductById
};
