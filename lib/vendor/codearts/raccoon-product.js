import { RACCOON_API_BASE, RACCOON_PHONE_CIPHER_SECRET } from "./raccoon.js";
const RACCOON_FALLBACK_MODELS = [
  {
    id: "sn-sensenova-6-8-flash",
    name: "SenseNova-6.8-Flash \xB7 \u514D\u8D39",
    contextWindow: 256e3,
    maxTokens: 63999,
    supportsImage: true
  },
  {
    id: "sn-sensenova-6-8-flash-lite",
    name: "SenseNova-6.8-Flash-Lite \xB7 \u514D\u8D39",
    contextWindow: 256e3,
    maxTokens: 63999,
    supportsImage: true
  },
  {
    id: "sn-glm-5-3",
    name: "GLM-5-3 \xB7 x0.75",
    contextWindow: 1e6,
    maxTokens: 1e5,
    supportsImage: true
  },
  {
    id: "sn-kimi-k3",
    // ⚠️ 1 倍也要显示（用户报障「为什么 Kimi-K3 没有倍率，ide 是 1 倍，
    // 1 倍也要显示倍率」）—— 见 `raccoonDisplayName` 的注释。
    name: "Kimi-K3 \xB7 x1",
    contextWindow: 1e6,
    maxTokens: 1e5,
    supportsImage: true
  },
  {
    id: "sn-glm-5-3-flash",
    name: "GLM-5-3-Flash \xB7 x0.2\u2192x0.1",
    contextWindow: 1e6,
    maxTokens: 1e5,
    supportsImage: false
  },
  {
    id: "sn-deepseek-v4-1-flash",
    name: "DeepSeek-V4.1-Flash \xB7 x0.25",
    contextWindow: 1e6,
    maxTokens: 1e5,
    supportsImage: false
  }
];
const RACCOON = {
  id: "raccoon",
  // ⚠️ 用『Raccoon (商汤)』而非『Raccoon Work (商汤)』—— 后者在 Jet Hub 的
  // provider Tab 里**触发换行**（用户报障）。客户端内的品牌名是 `Raccoon Work`，
  // 但那个词组太长；缩短成 `Raccoon` 后与其余 provider 的标签长度一致
  //（`CodeBuddy (腾讯)` / `LobsterAI (有道)` / `WorkBuddy (国际版)`）。
  displayName: "Raccoon (\u5546\u6C64)",
  apiBase: RACCOON_API_BASE,
  authApiPrefix: "/api/web/auth/v1",
  llmApiPrefix: "/api/web/llm/v2",
  pointsApiPrefix: "/api/web/points/v1",
  desktopApiPrefix: "/api/web/desktop/v1",
  userAgent: "Raccoon Work/1.0.35 (Windows)",
  clientPlatform: "desktop-windows",
  clientVersion: "v1.0.35",
  defaultCredentialRef: "RACCOON_ACCESS_TOKEN",
  phoneCipherSecret: RACCOON_PHONE_CIPHER_SECRET,
  aliyunCaptcha: { sceneId: "1pkmy0x3", prefix: "hk1r5l" },
  fallbackModels: RACCOON_FALLBACK_MODELS
};
const ALL_RACCOON_PRODUCTS = [RACCOON];
function raccoonProductById(id) {
  return ALL_RACCOON_PRODUCTS.find((product) => product.id === id);
}
export {
  ALL_RACCOON_PRODUCTS,
  RACCOON,
  raccoonProductById
};
