import {
  LOOMY_AUTH_ERROR_CODE,
  LOOMY_REQUEST_TIMEOUT_MS,
  parseLoomyEnvelope
} from "./loomy.js";
const LOOMY_TASK_POINTS = Object.freeze({
  first_message: 500,
  pick_skill: 1e3,
  generate_ppt: 1500,
  set_schedule: 1e3,
  install_skill: 1500,
  configure_remote: 1e3,
  create_soul: 1500,
  share_soul: 2e3
});
const LOOMY_TASK_TITLES = Object.freeze({
  first_message: "\u53D1\u9001\u4F60\u7684\u7B2C\u4E00\u6761\u6D88\u606F",
  pick_skill: "\u8BD5\u8BD5\u9009\u62E9\u4E00\u4E2A\u6280\u80FD",
  generate_ppt: "\u751F\u6210\u7B2C\u4E00\u4EFD PPT",
  set_schedule: "\u8BBE\u7F6E\u5B9A\u65F6\u4EFB\u52A1",
  install_skill: "\u5728\u6280\u80FD\u5E7F\u573A\u5B89\u88C5\u4E00\u4E2A\u6280\u80FD",
  configure_remote: "\u914D\u7F6E\u8FDC\u7A0B\u63A7\u5236",
  create_soul: "\u521B\u5EFA\u4F60\u7684\u7B2C\u4E00\u4E2A\u642D\u5B50",
  share_soul: "\u628A\u642D\u5B50\u5206\u4EAB\u7ED9\u670B\u53CB"
});
const LOOMY_ONBOARDING_TOTAL = 1e4;
function computeLoomyEarned(tasks) {
  return Object.keys(LOOMY_TASK_POINTS).reduce((sum, key) => tasks[key] === true ? sum + LOOMY_TASK_POINTS[key] : sum, 0);
}
function normalizeTasks(raw) {
  const source = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? raw : {};
  const normalized = {};
  for (const key of Object.keys(LOOMY_TASK_POINTS)) {
    normalized[key] = source[key] === true;
  }
  return normalized;
}
async function requestLoomy(credential, product, path, init, fetcher) {
  const headers = { Accept: "application/json", token: credential.access_token };
  let payload;
  if (init.body !== void 0) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(init.body);
  }
  let response;
  try {
    response = await fetcher(`${product.apiBase}${path}`, {
      method: init.method,
      headers,
      ...payload === void 0 ? {} : { body: payload },
      signal: AbortSignal.timeout(LOOMY_REQUEST_TIMEOUT_MS)
    });
  } catch (error) {
    throw new Error(`loomy: \u8BF7\u6C42\u5931\u8D25\uFF08${path}\uFF09\uFF1A${error instanceof Error ? error.message : String(error)}`);
  }
  let parsed;
  try {
    parsed = await response.json();
  } catch {
    throw new Error(`loomy: \u54CD\u5E94\u4E0D\u662F JSON\uFF08${path}\uFF0CHTTP ${response.status}\uFF09`);
  }
  const envelope = parseLoomyEnvelope(parsed);
  if (!envelope.ok) {
    if (envelope.code === LOOMY_AUTH_ERROR_CODE) {
      throw new Error(`loomy: ${envelope.message}`);
    }
    throw new Error(`loomy: ${envelope.message}`);
  }
  return envelope.data;
}
async function fetchLoomyOnboardingTasks(credential, product, fetcher = fetch) {
  const data = await requestLoomy(
    credential,
    product,
    "/onboarding/tasks",
    { method: "GET" },
    fetcher
  );
  const tasks = normalizeTasks(data?.tasks);
  return {
    tasks,
    earned: computeLoomyEarned(tasks),
    total: Number.isFinite(Number(data?.total)) ? Number(data?.total) : LOOMY_ONBOARDING_TOTAL
  };
}
async function completeLoomyTask(credential, key, product, fetcher = fetch) {
  if (!(key in LOOMY_TASK_POINTS)) {
    throw new Error(`loomy: \u672A\u77E5\u7684 task key: ${key}`);
  }
  const data = await requestLoomy(
    credential,
    product,
    "/onboarding/tasks/complete",
    { method: "POST", body: { key } },
    fetcher
  );
  return {
    alreadyCompleted: data?.alreadyCompleted === true,
    balance: Number.isFinite(Number(data?.balance)) ? Number(data?.balance) : 0
  };
}
async function claimAllLoomyOnboardingTasks(credential, product, fetcher = fetch) {
  const state = await fetchLoomyOnboardingTasks(credential, product, fetcher);
  const claimed = [];
  const skipped = [];
  const nextTasks = { ...state.tasks };
  for (const key of Object.keys(LOOMY_TASK_POINTS)) {
    if (state.tasks[key] === true) {
      skipped.push(key);
      continue;
    }
    await completeLoomyTask(credential, key, product, fetcher);
    claimed.push({ key, points: LOOMY_TASK_POINTS[key] });
    nextTasks[key] = true;
  }
  return {
    claimed,
    skipped,
    earned: computeLoomyEarned(nextTasks),
    total: state.total
  };
}
export {
  LOOMY_ONBOARDING_TOTAL,
  LOOMY_TASK_POINTS,
  LOOMY_TASK_TITLES,
  claimAllLoomyOnboardingTasks,
  completeLoomyTask,
  computeLoomyEarned,
  fetchLoomyOnboardingTasks
};
