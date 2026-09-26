import { LOOMY_ACCOUNT_BASE, LOOMY_API_BASE } from "./loomy.js";
const LOOMY_FALLBACK_MODELS = [
  { id: "deepseek-v4-flash-0731", name: "DeepSeek V4 Flash 0731 \xB7 x3.0", contextWindow: 1048576 },
  { id: "MiniMax-M3", name: "MiniMax M3 \xB7 x4.0", contextWindow: 1048576 },
  { id: "Kimi-k2.6", name: "Kimi k2.6 \xB7 x6.5", contextWindow: 262144 },
  { id: "qwen-3.8-max", name: "Qwen 3.8 Max \xB7 x12.0", contextWindow: 1e6 },
  { id: "GLM-5.3-Flash", name: "GLM 5.3 Flash \xB7 x0.8", contextWindow: 1048576 },
  { id: "qwen3.8-flash", name: "qwen 3.8 flash \xB7 x0.8", contextWindow: 1e6 },
  { id: "spark-x", name: "Spark X2.5 \xB7 x0.1", contextWindow: 1048576 },
  { id: "mimo-v2.5", name: "MiMo V2.5 \xB7 x3.3", contextWindow: 1048576 }
];
const LOOMY = {
  id: "loomy",
  displayName: "Loomy (\u8BAF\u98DE)",
  apiBase: LOOMY_API_BASE,
  accountBase: LOOMY_ACCOUNT_BASE,
  // 取自 `.env.prod`（VITE_XFYUN_ACCESS_KEY_ID / _SECRET / _APP_ID）。
  accessKeyId: "2thryby66wxi53sk",
  accessKeySecret: "zsak6eadrbawz683wf5r3m2snrwj868r",
  appId: "GM3LOOMY",
  defaultCredentialRef: "LOOMY_ACCESS_TOKEN",
  fallbackModels: LOOMY_FALLBACK_MODELS
};
const ALL_LOOMY_PRODUCTS = [LOOMY];
function loomyProductById(id) {
  return ALL_LOOMY_PRODUCTS.find((product) => product.id === id);
}
export {
  ALL_LOOMY_PRODUCTS,
  LOOMY,
  loomyProductById
};
