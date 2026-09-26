const QODER_FALLBACK_MODELS = [
  // ⚠️ 全部数值逐条对照本机 catalog-v6 实测（2026-09-21）。早期版本多处为
  // 手工估值，与真实值**大范围不符**（14 个模型有偏差，如 `smodel` 写 3.2
  // 实际 8、`qmodel_38max` 写 0.5 实际 0.2），用户据此报障。
  // 改动本表时必须重新对照 catalog，不要凭印象填。
  //
  // 字段顺序：id, 展示名, 上下文, vl, reasoning, free, 倍率
  { id: "auto", name: "Auto", contextWindow: 2e5, supportsImage: true, supportsThinking: false, priceFactor: 0.5 },
  { id: "ultimate", name: "Ultimate", contextWindow: 1e6, supportsImage: true, supportsThinking: true, priceFactor: 2, efforts: ["xhigh", "high", "low", "max", "medium"] },
  // ⚠️ `is_reasoning: false` 但 `thinking_config.enabled` 为真 —— 上游确实
  // 提供档位选择，故 `efforts` 保留；而请求体的 `isReasoning` 取 `is_reasoning`。
  { id: "performance", name: "Performance", contextWindow: 1e6, supportsImage: true, supportsThinking: false, priceFactor: 1.1, efforts: ["xhigh", "high", "low", "max", "medium"] },
  { id: "efficient", name: "Efficient", contextWindow: 2e5, supportsImage: true, supportsThinking: false, priceFactor: 0.3 },
  { id: "smodel", name: "Sonus", contextWindow: 18e4, supportsImage: true, supportsThinking: true, priceFactor: 8, efforts: ["xhigh", "high", "low", "max", "medium"] },
  { id: "cmodel", name: "Cantus", contextWindow: 18e4, supportsImage: true, supportsThinking: true, priceFactor: 4, efforts: ["xhigh", "high", "low", "max", "medium"] },
  // 免费额度模型（is_free=true）：e2e 探针默认用它们以免消耗积分。
  // ⚠️ `priceFactor` 是**采集时刻的生效价**（窗口内为折后价），原价在
  // `promotion.beforePromotionPriceFactor`；展示时本地推算当前价。
  {
    id: "qmodel_38max",
    name: "Qwen3.8-Max",
    contextWindow: 18e4,
    supportsImage: true,
    supportsThinking: true,
    isFree: true,
    priceFactor: 0.2,
    efforts: ["xhigh", "low", "medium"],
    promotion: { active: true, discountFactor: 0.4, beforePromotionPriceFactor: 0.5, windowStart: "22:00", windowEnd: "08:00", badgeZh: "\u9519\u5CF0 4 \u6298" }
  },
  {
    // ⚠️ `priceFactor: 0` 是**免费**（实测），不是缺失 —— 见接口注释。
    id: "qfmodel",
    name: "Qwen3.8-Flash",
    contextWindow: 18e4,
    supportsImage: true,
    supportsThinking: true,
    isFree: true,
    priceFactor: 0,
    originalPriceFactor: 0.1,
    efforts: ["xhigh", "low", "medium"]
  },
  {
    id: "qmodel_latest",
    name: "Qwen3.7-Max",
    contextWindow: 1e6,
    supportsImage: true,
    supportsThinking: false,
    priceFactor: 0.1,
    originalPriceFactor: 0.5,
    promotion: { active: true, discountFactor: 0.2, beforePromotionPriceFactor: 0.5, windowStart: "22:00", windowEnd: "08:00", badgeZh: "\u9519\u5CF0 2 \u6298" }
  },
  {
    id: "qmodel",
    name: "Qwen3.7-Plus",
    contextWindow: 1e6,
    supportsImage: true,
    supportsThinking: false,
    priceFactor: 0.04,
    promotion: { active: true, discountFactor: 0.4, beforePromotionPriceFactor: 0.1, windowStart: "22:00", windowEnd: "08:00", badgeZh: "\u9519\u5CF0 4 \u6298" }
  },
  { id: "kmodel_latest", name: "Kimi-K3", contextWindow: 18e4, supportsImage: true, supportsThinking: false, priceFactor: 1.4, efforts: ["high", "low", "max"] },
  // ⚠️ 该模型**未下发 `max_input_tokens`**，此处取 `context_config` 里
  // `is_default: true` 的那档（200K）。
  { id: "kmodel", name: "Kimi-K2.8-Preview", contextWindow: 2e5, supportsImage: true, supportsThinking: false, priceFactor: 0.8, efforts: ["high", "low", "max"] },
  { id: "gmodel", name: "GLM-5.3", contextWindow: 18e4, supportsImage: true, supportsThinking: true, priceFactor: 0.8, efforts: ["high", "low", "max"] },
  { id: "gfmodel", name: "GLM-5.3-Flash", contextWindow: 1e6, supportsImage: true, supportsThinking: true, priceFactor: 0.1, efforts: ["high", "max"] },
  { id: "dmodel", name: "DeepSeek-V4-Pro", contextWindow: 1e6, supportsImage: true, supportsThinking: true, priceFactor: 0.5, efforts: ["high", "max"] },
  { id: "dfmodel", name: "DeepSeek-Flash", contextWindow: 1e6, supportsImage: true, supportsThinking: true, priceFactor: 0.1, efforts: ["high", "max", "low"] },
  { id: "mmodel", name: "MiniMax-M3", contextWindow: 18e4, supportsImage: true, supportsThinking: false, priceFactor: 0.2 }
];
const QODER = {
  id: "qoder",
  displayName: "Qoder",
  authBase: "https://qoder.com",
  openApiBase: "https://openapi.qoder.sh",
  inferBase: "https://api2-v2.qoder.sh",
  encryptedInferBase: "https://api2.qoder.sh",
  clientId: "e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb",
  testClientId: "e93fe488-5778-4c35-a6fc-0f54ed7b3139",
  clientMetadata: {
    client_type: "5",
    business_product: "cli",
    business_type: "agent",
    scene: "assistant"
  },
  // 官方桌面客户端身份（源码常量 `Mh.clientType`）。仅用于 `/sash/` 端点。
  sashClientType: "10",
  userAgentPrefix: "qoder",
  defaultCredentialRef: "QODER_ACCESS_TOKEN",
  fallbackModels: QODER_FALLBACK_MODELS
};
const ALL_QODER_PRODUCTS = [QODER];
function qoderProductById(id) {
  return ALL_QODER_PRODUCTS.find((product) => product.id === id);
}
export {
  ALL_QODER_PRODUCTS,
  QODER,
  qoderProductById
};
