const TRAE_AGENT_HOST = "https://trae-api-cn.mchost.guru";
const TRAE_UG_HOST = "https://api.trae.cn";
const TRAE_OAUTH_HOST = "https://api.trae.com.cn";
const TRAE_CONSOLE_HOST = "https://www.trae.cn";
const TRAE_FALLBACK_MODELS = [
  { id: "DeepSeek-V4-Flash-Official", name: "DeepSeek V4 Flash Official", contextWindow: 2e5 },
  { id: "Doubao-Seed-2.1-Pro", name: "Doubao Seed 2.1 Pro", contextWindow: 2e5 },
  { id: "seed-code-pro-0430", name: "Seed Code Pro 0430", contextWindow: 2e5 },
  { id: "Doubao-Seed-2.1-Turbo", name: "Doubao Seed 2.1 Turbo", contextWindow: 2e5 },
  { id: "Doubao-Seed-2.0-Code", name: "Doubao Seed 2.0 Code", contextWindow: 2e5 },
  { id: "browser_use_subagent", name: "Browser Use Subagent", contextWindow: 2e5, isHidden: true },
  { id: "glm-5.2", name: "GLM-5.2", contextWindow: 2e5 },
  { id: "glm-5-turbo", name: "GLM-5 Turbo", contextWindow: 2e5 },
  { id: "glm-5", name: "GLM-5", contextWindow: 2e5 },
  { id: "DeepSeek-V4-Pro", name: "DeepSeek V4 Pro", contextWindow: 2e5 },
  { id: "DeepSeek-V4-Flash", name: "DeepSeek V4 Flash", contextWindow: 2e5 },
  { id: "kimi-k3", name: "Kimi K3", contextWindow: 2e5 },
  { id: "kimi-k2.7-code", name: "Kimi K2.7 Code", contextWindow: 2e5 },
  { id: "kimi-k2.6", name: "Kimi K2.6", contextWindow: 2e5 },
  { id: "minimax-m3", name: "MiniMax M3", contextWindow: 2e5 },
  { id: "qwen-3.7-plus", name: "Qwen 3.7 Plus", contextWindow: 2e5 },
  { id: "sagitta", name: "Sagitta", contextWindow: 2e5 },
  { id: "aquila", name: "Aquila", contextWindow: 2e5 },
  { id: "custom_model_gemini", name: "Custom Gemini", contextWindow: 2e5 },
  { id: "custom_model_placeholder", name: "Custom Placeholder", contextWindow: 2e5 },
  { id: "custom_model_1M_text", name: "Custom 1M Text", contextWindow: 2e5 },
  { id: "custom_model_1M", name: "Custom 1M", contextWindow: 2e5 },
  { id: "custom_model_kimi", name: "Custom Kimi", contextWindow: 2e5 },
  { id: "custom_model_claude", name: "Custom Claude", contextWindow: 2e5 },
  { id: "custom_model_gpt-5", name: "Custom GPT-5", contextWindow: 2e5 },
  { id: "custom_model_no-fc", name: "Custom No-FC", contextWindow: 2e5 },
  { id: "custom_model_deepseek_chat", name: "Custom DeepSeek Chat", contextWindow: 2e5 },
  { id: "custom_model_deepseek_reasoner", name: "Custom DeepSeek Reasoner", contextWindow: 2e5 },
  { id: "custom_model_deepseek_v4", name: "Custom DeepSeek V4", contextWindow: 2e5 },
  { id: "explore_sub_agent_v13", name: "Explore Sub Agent V13", contextWindow: 2e5, isHidden: true },
  { id: "explore_sub_agent_v2", name: "Explore Sub Agent V2", contextWindow: 2e5, isHidden: true },
  { id: "summary", name: "Summary", contextWindow: 2e5, isHidden: true }
];
const TRAE_CHANNELS = resolveChannelList(
  process.env.DSH_TRAE_CHANNELS
);
function resolveChannelList(raw) {
  const fallback = ["solo_agent", "solo_work_lite", "solo_agent_remote"];
  if (raw === void 0) return fallback;
  const parsed = raw.split(",").map((item) => item.trim()).filter((item) => item.length > 0);
  return parsed.length > 0 ? parsed : fallback;
}
function isTruthyFlag(raw) {
  if (raw === void 0) return false;
  const value = raw.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}
function resolveMaxModeFlag(raw) {
  if (raw === void 0) return true;
  const value = raw.trim().toLowerCase();
  return !(value === "0" || value === "false" || value === "no" || value === "off");
}
function resolveMaxModeModels(raw) {
  if (raw === void 0) return void 0;
  const parsed = raw.split(",").map((item) => item.trim()).filter((item) => item.length > 0);
  return parsed.length > 0 ? parsed : void 0;
}
const TRAE = {
  id: "trae",
  displayName: "TRAE (\u5B57\u8282)",
  agentHost: TRAE_AGENT_HOST,
  ugHost: TRAE_UG_HOST,
  oauthHost: TRAE_OAUTH_HOST,
  consoleHost: TRAE_CONSOLE_HOST,
  clientId: "en1oxy7wnw8j9n",
  appId: "6eefa01c-1036-4c7e-9ca5-d891f63bfcd8",
  ideVersion: "0.1.52",
  ideVersionCode: "20260811",
  deviceBrand: "Apple",
  osVersion: "macOS 15.7.4",
  function: "solo_work_lite",
  channels: TRAE_CHANNELS,
  fallbackMaxOutputTokens: 32e3,
  maxMode: resolveMaxModeFlag(process.env.DSH_TRAE_MAX_MODE),
  maxModeModels: resolveMaxModeModels(process.env.DSH_TRAE_MAX_MODELS),
  hideInternalModels: isTruthyFlag(process.env.DSH_TRAE_HIDE_INTERNAL),
  pluginVersion: "2.3.62834",
  defaultCredentialRef: "TRAE_ACCESS_TOKEN",
  userAgent: "Trae/0.1.52",
  fallbackModels: TRAE_FALLBACK_MODELS
};
export {
  TRAE,
  TRAE_AGENT_HOST,
  TRAE_CHANNELS,
  TRAE_CONSOLE_HOST,
  TRAE_OAUTH_HOST,
  TRAE_UG_HOST
};
