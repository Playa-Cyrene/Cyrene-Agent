"use strict";

/**
 * 把订阅模型目录同步成 Cyrene 的模型档案（modelProfiles）。
 *
 * 每个订阅渠道生成一个多模型档案（Cyrene 1.3.0+）：
 *   baseUrl     → 插件代理地址 http://127.0.0.1:<port>/v1
 *   transport   → 按订阅原生协议（chatgpt/grok=responses / claude=anthropic）
 *   apiKey      → 占位（代理不校验）
 *   models / modelOptions → 模型清单及每个模型的上下文、视觉、推理能力
 * 旧版单模型档案先迁移会话绑定，再清理；无宿主窗口时保留旧档案等待重试。
 *
 * 写入路径（不 require 宿主内部模块，符合插件仓库审核要求）：
 *   1) 优先经渲染进程公开 API `window.settings.saveModelProfile()` 写入
 *      —— 宿主会同步更新内存缓存，聊天窗口选择器立即生效；
 *   2) 没有可用宿主窗口时回退为直接写 model-settings.json（需重启 Cyrene 生效）。
 *
 * 与主仓库 src/main/settings/model-catalog.ts 的 SavedModelProfile 结构对齐。
 */

const { resolveContextWindow } = require("./model-context.cjs");

/** 每订阅的档案前缀，便于识别与清理。 */
const PROFILE_PREFIX = "oauth-sub-";

/** provider 显示名（设置页档案列表展示用）。 */
const PROVIDER_LABELS = {
  chatgpt: "ChatGPT（OpenAI）订阅",
  claude: "Claude（Anthropic）订阅",
  grok: "Grok（xAI）订阅",
};

/**
 * 各订阅的原生协议 —— 代理按原生协议直通，不做格式转换：
 *  - chatgpt → responses（Codex 端点，Cyrene 的 Responses transport 会发 store:false + instructions）
 *  - claude  → anthropic（Messages API）
 *  - grok    → responses（xAI 原生服务端搜索只在 Responses API 提供）
 */
const PROVIDER_TRANSPORT = {
  chatgpt: "responses",
  claude: "anthropic",
  grok: "responses",
};

/** 模型名 → 是否默认多模态（代理透传，能力最终由服务端裁定）。 */
function modelSupportsVision() {
  return true;
}

/**
 * 从目录条目推断 reasoning preference。
 * 目录无 effort 信息时返回 undefined（走模型名规则表兜底）。
 * @param {{efforts?: string[]}} model
 */
function reasoningFromModel(model) {
  const order = ["max", "xhigh", "high", "medium", "low", "minimal"];
  const sorted = order.filter((effort) => Array.isArray(model.efforts) && model.efforts.includes(effort));
  if (sorted.length === 0) return undefined;
  const defaultEffort = sorted.length > 2 ? sorted[Math.floor(sorted.length / 2)] : sorted[sorted.length - 1];
  return { mode: "on", effort: defaultEffort };
}

function selectableModels(profile) {
  const values = Array.isArray(profile.models) && profile.models.length ? profile.models : [profile.model];
  return [...new Set(values.filter((value) => typeof value === "string").map((value) => value.trim()).filter(Boolean))];
}

function catalogModelOption(providerId, model) {
  const option = {
    contextWindowTokens: Math.max(4096, Math.round(resolveContextWindow(model.id, model.contextWindow, model))),
    multimodal: modelSupportsVision(providerId),
  };
  const reasoning = reasoningFromModel(model);
  // 目录是未知/新模型推理能力的来源；用户手动配置的规则在合并时优先保留。
  if (reasoning && (providerId === "chatgpt" || providerId === "grok")) {
    option.manualReasoning = {
      style: "openai-effort",
      supportedEfforts: ["minimal", "low", "medium", "high", "xhigh", "max"].filter((effort) => model.efforts.includes(effort)),
      defaultEffort: reasoning.effort,
      supportsDisable: model.efforts.includes("none"),
    };
  }
  return option;
}

/**
 * 生成一个渠道档案（不写盘）。旧档案 id 继续作为该渠道 id，避免默认绑定失效。
 * @param {string} providerId
 * @param {Array<{id: string, name?: string, efforts?: string[], contextWindow?: number}>} models
 * @param {{port: number}} proxyInfo
 */
function buildProfiles(providerId, models, proxyInfo, settings = {}) {
  if (!Object.hasOwn(PROVIDER_TRANSPORT, providerId)) throw new Error("未知订阅渠道");
  if (!isValidPort(proxyInfo.port)) throw new Error("本地代理端口无效");
  const owned = (settings.modelProfiles || []).filter((profile) => providerIdFromProfile(profile) === providerId);
  const anchor = owned.find((profile) => profile.id === `${PROFILE_PREFIX}${providerId}`)
    || owned.find((profile) => Array.isArray(profile.models) && profile.models.length > 1)
    || owned.find((profile) => profile.id === settings.defaultModelProfileId)
    || owned[0];
  const incoming = new Map();
  for (const model of models) {
    if (!model || typeof model.id !== "string" || !model.id.trim()) continue;
    incoming.set(model.id.trim(), { ...model, id: model.id.trim() });
  }
  const orderedOwned = anchor ? [anchor, ...owned.filter((profile) => profile !== anchor)] : [];
  const modelIds = [...new Set([...orderedOwned.flatMap(selectableModels), ...incoming.keys()])];
  if (modelIds.length === 0) return [];
  const preferredDefault = owned.find((profile) => profile.id === settings.defaultModelProfileId)?.model ?? anchor?.model;
  const defaultModel = modelIds.includes(preferredDefault) ? preferredDefault : modelIds[0];
  const modelOptions = Object.fromEntries(modelIds.map((id) => {
    let savedOption = {};
    for (const profile of orderedOwned) {
      if (!selectableModels(profile).includes(id)) continue;
      savedOption = {
        ...(typeof profile.contextWindowTokens === "number" ? { contextWindowTokens: profile.contextWindowTokens } : {}),
        ...(typeof profile.multimodal === "boolean" ? { multimodal: profile.multimodal } : {}),
        ...profile.modelOptions?.[id],
      };
      break;
    }
    return [id, { ...catalogModelOption(providerId, incoming.get(id) || { id }), ...savedOption }];
  }));
  const baseUrl = `http://127.0.0.1:${proxyInfo.port}/v1`;
  const label = PROVIDER_LABELS[providerId];
  const displayName = anchor?.displayName && !anchor.displayName.startsWith(`${label} · `)
    ? anchor.displayName : label;
  return [{
    ...anchor,
    id: anchor?.id || `${PROFILE_PREFIX}${providerId}`,
    provider: label,
    displayName,
    baseUrl,
    model: defaultModel,
    ...(modelIds.length > 1 ? { models: modelIds } : { models: undefined }),
    modelOptions,
    apiKey: "oauth-subscription",
    explicitTransport: PROVIDER_TRANSPORT[providerId],
    nativeWebSearch: true,
    reasoning: anchor?.reasoning ?? reasoningFromModel(incoming.get(defaultModel) || {}),
    contextWindowTokens: modelOptions[defaultModel].contextWindowTokens,
    multimodal: modelOptions[defaultModel].multimodal,
  }];
}

/** 配置文件路径（Cyrene 数据目录；用户点击"写入档案"即视为授权写入）。 */
function modelSettingsPath() {
  const path = require("node:path");
  const { app } = require("electron");
  return path.join(app.getPath("userData"), "model-settings.json");
}

/** 读取现有档案列表（纯文件读，不依赖宿主内部模块）。 */
function readExistingProfiles() {
  const fs = require("node:fs");
  try {
    const settings = JSON.parse(fs.readFileSync(modelSettingsPath(), "utf8"));
    return { ok: true, settings, profiles: Array.isArray(settings.modelProfiles) ? settings.modelProfiles : [] };
  } catch (error) {
    if (error.code === "ENOENT") return { ok: true, settings: { modelProfiles: [] }, profiles: [] };
    return { ok: false, error: `无法读取模型配置：${error.message}` };
  }
}

function isValidPort(port) {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

/** 只接受本插件生成的本机 HTTP 代理地址，避免误用用户自定义远端端口。 */
function localProxyPort(baseUrl) {
  try {
    const parsed = new URL(String(baseUrl || ""));
    if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1") return undefined;
    const port = Number(parsed.port);
    return isValidPort(port) ? port : undefined;
  } catch {
    return undefined;
  }
}

function providerIdFromProfile(profile) {
  const id = String(profile && profile.id || "");
  for (const providerId of Object.keys(PROVIDER_TRANSPORT)) {
    if (id === `${PROFILE_PREFIX}${providerId}` || id.startsWith(`${PROFILE_PREFIX}${providerId}-`)) return providerId;
  }
  return undefined;
}

function normalizeOwnedProfile(profile, baseUrl) {
  const providerId = providerIdFromProfile(profile);
  if (!providerId) return profile;
  return {
    ...profile,
    baseUrl,
    explicitTransport: PROVIDER_TRANSPORT[providerId],
    nativeWebSearch: true,
  };
}

/**
 * 优先复用既有订阅档案中的代理端口。
 *
 * 这一步必须发生在 proxy.start() 前：宿主会在插件启动前缓存模型设置；若插件每次都先
 * 抢默认端口、再把磁盘档案改到新端口，当前进程仍会拿旧缓存请求，表现为 0 轮次的
 * E_HARNESS_FAILURE。复用档案端口可让绝大多数启动从一开始就与宿主缓存一致。
 */
function preferredProxyPortFromProfiles(fallbackPort) {
  const safeFallback = isValidPort(fallbackPort) ? fallbackPort : 6231;
  const read = readExistingProfiles();
  if (!read.ok) return safeFallback;
  for (const profile of read.profiles) {
    if (!String(profile.id || "").startsWith(PROFILE_PREFIX)) continue;
    const port = localProxyPort(profile.baseUrl);
    if (port !== undefined) return port;
  }
  return safeFallback;
}

function syncPlan(providerId, models, proxyInfo, settings) {
  const profile = buildProfiles(providerId, models, proxyInfo, settings)[0];
  if (!profile) return undefined;
  const owned = (settings.modelProfiles || []).filter((saved) => providerIdFromProfile(saved) === providerId);
  return {
    profile,
    retired: owned.filter((saved) => saved.id !== profile.id),
    added: owned.length === 0 ? 1 : 0,
    updated: owned.length > 0 ? 1 : 0,
  };
}

/**
 * 此函数在宿主渲染进程执行，只使用公开 settings / chatStore API。
 * 先保存渠道档案，迁移全部旧会话并保持有效模型，再移除旧档案。
 * 中途失败时保留旧档案；再次同步可继续，不会把旧聊天静默切到其他渠道。
 */
async function collectSessionBindings({ plans, pending }) {
  const chats = window.chatStore;
  if (!window.settings) return { ok: false, unavailable: true };
  if (!chats || ["list", "get", "setModelProfile", "setSessionModel"].some((key) => typeof chats[key] !== "function")) {
    return { ok: false, migrationPending: true, error: "宿主会话 API 尚未就绪" };
  }
  const sessions = await chats.list();
  if (!Array.isArray(sessions)) return { ok: false, error: "无法读取旧会话绑定" };
  const bindings = [];
  for (const meta of sessions) {
    const session = await chats.get(meta.id);
    if (!session) continue;
    for (const plan of plans) {
      const previous = pending.find((binding) => binding.sessionId === session.id && binding.targetId === plan.profile.id);
      const oldProfile = plan.retired.find((profile) => profile.id === session.modelProfileId);
      if (previous && (oldProfile || session.modelProfileId === plan.profile.id)) bindings.push(previous);
      else if (oldProfile) {
        const models = oldProfile.models?.length ? oldProfile.models : [oldProfile.model];
        bindings.push({
          sessionId: session.id, oldId: oldProfile.id, targetId: plan.profile.id,
          model: models.includes(session.model) ? session.model : oldProfile.model,
        });
      }
    }
  }
  return { ok: true, bindings };
}

async function applySyncPlans({ plans, bindings }) {
  const api = window.settings;
  const chats = window.chatStore;
  if (!api || typeof api.saveModelProfile !== "function" || typeof api.listModelProfiles !== "function") {
    return { ok: false, unavailable: true };
  }
  let migratedSessions = 0;
  let removed = 0;
  for (const plan of plans) {
    const saved = await api.saveModelProfile(plan.profile);
    const savedProfile = saved?.profiles?.find((profile) => profile.id === plan.profile.id);
    const expectedModels = plan.profile.models || [plan.profile.model];
    if (!savedProfile || expectedModels.some((model) => !(savedProfile.models || [savedProfile.model]).includes(model))) {
      return { ok: false, incompatibleHost: true, error: "宿主未保存多模型档案，请使用 Cyrene 1.3.0 或更新版本" };
    }
    const moves = bindings.filter((binding) => binding.targetId === plan.profile.id);
    if (plan.retired.length === 0 && moves.length === 0) continue;
    try {
      if (!chats || ["list", "get", "setModelProfile", "setSessionModel"].some((key) => typeof chats[key] !== "function")
        || typeof api.deleteModelProfile !== "function" || typeof api.setDefaultModelProfile !== "function") {
        throw new Error("宿主会话 API 尚未就绪");
      }
      const retired = new Map(plan.retired.map((profile) => [profile.id, profile]));
      for (const move of moves) {
        const session = await chats.get(move.sessionId);
        if (!session || (session.modelProfileId !== move.oldId && session.modelProfileId !== plan.profile.id)) continue;
        if (session.modelProfileId === plan.profile.id && session.model === move.model) continue;
        const model = move.model;
        if (!expectedModels.includes(model)) throw new Error("旧会话模型不在合并后的清单内");
        try {
          const rebound = await chats.setModelProfile(session.id, plan.profile.id);
          if (!rebound || rebound.modelProfileId !== plan.profile.id) throw new Error("迁移会话绑定失败");
          const selected = await chats.setSessionModel(session.id, model);
          if (!selected?.ok) throw new Error("恢复会话模型失败");
          migratedSessions += 1;
        } catch (error) {
          // 保住失败会话的原渠道与模型，其余已迁移会话无需回滚。
          try {
            await chats.setModelProfile(session.id, move.oldId);
            await chats.setSessionModel(session.id, model);
          } catch { /* 旧档案不删除，下次同步继续 */ }
          throw error;
        }
      }
      const current = await api.listModelProfiles();
      if (retired.has(current.defaultModelProfileId)) await api.setDefaultModelProfile(plan.profile.id);
      // 迁移期间可能新建了绑定旧档案的聊天；保留旧档案并在下一次同步补迁。
      for (const meta of await chats.list()) {
        const session = await chats.get(meta.id);
        if (session && retired.has(session.modelProfileId)) throw new Error("仍有旧会话等待迁移");
      }
      for (const profile of plan.retired) {
        const deleted = await api.deleteModelProfile(profile.id);
        if (!deleted || deleted.profiles?.some((saved) => saved.id === profile.id)) throw new Error("清理旧档案失败");
        removed += 1;
      }
    } catch (error) {
      return {
        ok: true,
        migrationPending: true,
        migratedSessions,
        removed,
        warning: `渠道模型已同步，旧档案暂时保留：${error.message}。打开聊天窗口后重试同步即可完成合并`,
      };
    }
  }
  const current = await api.listModelProfiles();
  return { ok: true, profiles: current.profiles.length, migratedSessions, removed };
}

async function runViaRenderer(fn, payload) {
  const { BrowserWindow } = require("electron");
  const encoded = JSON.stringify(JSON.stringify(payload));
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    try {
      const result = await win.webContents.executeJavaScript(`(${fn.toString()})(JSON.parse(${encoded}))`, true);
      if (result && !result.unavailable) return result;
    } catch {
      // 插件自身的窗口没有宿主 API；窗口关闭或 IPC 未就绪时尝试下一个。
    }
  }
  return { ok: false, error: "没有可用的宿主窗口（请先打开聊天或设置窗口后重试）" };
}

/** 在改会话前持久化目标模型，窗口关闭或回滚失败后仍可继续迁移。只保存绑定，不含聊天内容/凭据。 */
async function syncViaRenderer(plans) {
  const fs = require("node:fs");
  const path = require("node:path");
  const { app } = require("electron");
  const version = app.getVersion?.()?.match(/^(\d+)\.(\d+)/);
  if (version && (Number(version[1]) < 1 || (Number(version[1]) === 1 && Number(version[2]) < 3))) {
    return { ok: false, incompatibleHost: true, error: "多模型渠道档案需要 Cyrene 1.3.0 或更新版本" };
  }
  const journalPath = path.join(app.getPath("userData"), "plugin-data", "subscription-oauth", "profile-migration.json");
  let pending = [];
  try {
    pending = JSON.parse(fs.readFileSync(journalPath, "utf8"));
    if (!Array.isArray(pending)) throw new Error("迁移记录格式无效");
  } catch (error) {
    if (error.code !== "ENOENT") return { ok: false, error: `无法读取档案迁移记录：${error.message}` };
  }
  const targetIds = new Set(plans.map((plan) => plan.profile.id));
  let bindings = [];
  if (plans.some((plan) => plan.retired.length > 0) || pending.some((move) => targetIds.has(move.targetId))) {
    const collected = await runViaRenderer(collectSessionBindings, { plans, pending });
    if (!collected.ok) return collected;
    bindings = collected.bindings;
  }
  const remaining = pending.filter((move) => !targetIds.has(move.targetId));
  const persist = (records) => {
    fs.mkdirSync(path.dirname(journalPath), { recursive: true });
    fs.writeFileSync(`${journalPath}.tmp`, JSON.stringify(records), "utf8");
    fs.renameSync(`${journalPath}.tmp`, journalPath);
  };
  try {
    if (bindings.length || pending.length) persist([...remaining, ...bindings]);
  } catch (error) {
    return { ok: false, error: `无法保存档案迁移记录：${error.message}` };
  }
  const result = await runViaRenderer(applySyncPlans, { plans, bindings });
  if (result.ok && !result.migrationPending && (bindings.length || pending.length)) {
    try { persist(remaining); } catch { /* 已迁移会话在下次同步时被识别，保留记录即可安全重试 */ }
  }
  return result;
}

/** 删除某订阅档案（同样优先经渲染进程 API）。 */
async function deleteProfilesViaRenderer(ids) {
  return runViaRenderer(async function deleteOwned(idsToDelete) {
    const api = window.settings;
    if (!api || typeof api.deleteModelProfile !== "function") return { ok: false, unavailable: true };
    for (const id of idsToDelete) {
      const result = await api.deleteModelProfile(id);
      if (!result || result.profiles?.some((profile) => profile.id === id)) return { ok: false, error: "删除订阅档案失败" };
    }
    return { ok: true };
  }, ids);
}

/** 回退只更新渠道档案，不删除仍被旧会话引用的档案。 */
function writeProfilesToDisk(desired) {
  const fs = require("node:fs");
  const read = readExistingProfiles();
  if (!read.ok) return read;
  const settings = read.settings;

  const result = read.profiles.map((saved) => desired.find((profile) => profile.id === saved.id) || saved);
  for (const profile of desired) {
    if (!result.some((saved) => saved.id === profile.id)) result.push(profile);
  }
  settings.modelProfiles = result;
  if (!settings.defaultModelProfileId) settings.defaultModelProfileId = result[0]?.id;
  try {
    fs.writeFileSync(modelSettingsPath(), JSON.stringify(settings, null, 2), "utf8");
  } catch (error) {
    return { ok: false, error: `写入模型配置失败：${error.message}` };
  }
  return { ok: true, profiles: result.length };
}

/**
 * 插件启动时把自有档案迁移到当前端口与最新能力声明。
 * 这里先落盘完成持久化；当前进程里已经加载的宿主缓存由
 * refreshProfilesInHostCache() 通过公开的 settings API 随后刷新。
 * 非 oauth-sub-* 档案及其余字段全部保持不变。
 */
function rebindProfilesToProxyPort(port) {
  if (!isValidPort(port)) {
    return { ok: false, error: "本地代理端口无效" };
  }
  const read = readExistingProfiles();
  if (!read.ok) return read;

  const baseUrl = `http://127.0.0.1:${port}/v1`;
  let updated = 0;
  const profiles = read.profiles.map((profile) => {
    const providerId = providerIdFromProfile(profile);
    if (!providerId) return profile;
    const normalized = normalizeOwnedProfile(profile, baseUrl);
    if (profile.baseUrl === normalized.baseUrl
      && profile.explicitTransport === normalized.explicitTransport
      && profile.nativeWebSearch === true) {
      return profile;
    }
    updated += 1;
    return normalized;
  });
  if (updated === 0) return { ok: true, updated: 0, profiles: profiles.length };

  read.settings.modelProfiles = profiles;
  try {
    const fs = require("node:fs");
    fs.writeFileSync(modelSettingsPath(), JSON.stringify(read.settings, null, 2), "utf8");
  } catch (error) {
    return { ok: false, error: `迁移订阅模型代理端口失败：${error.message}` };
  }
  return { ok: true, updated, profiles: profiles.length };
}

/**
 * 经宿主公开 API 重放现有订阅档案，确保主进程模型设置缓存与代理实际端口一致。
 *
 * 即使磁盘上的 baseUrl 已经正确也必须重放：端口迁移发生在插件启动阶段时，宿主往往
 * 已先读取并缓存旧文件。该函数只走公开 API，不再回退写盘，便于调用方等待宿主窗口
 * 就绪后安全重试。
 */
async function refreshProfilesInHostCache(port) {
  return withProfileMutation(() => refreshProfilesInHostCache0(port));
}

async function refreshProfilesInHostCache0(port) {
  if (!isValidPort(port)) return { ok: false, error: "本地代理端口无效" };
  const read = readExistingProfiles();
  if (!read.ok) return read;

  const providerIds = [...new Set(read.profiles.map(providerIdFromProfile).filter(Boolean))];
  const plans = providerIds.map((providerId) => syncPlan(providerId, [], { port }, read.settings)).filter(Boolean);
  if (plans.length === 0) return { ok: true, synced: 0 };
  const result = await syncViaRenderer(plans);
  if (!result.ok) return result;
  return { ...result, synced: plans.length };
}

// 启动刷新、手动添加和目录同步串行执行，防止两个操作覆盖对方的模型清单。
let profileMutationQueue = Promise.resolve();
function withProfileMutation(operation) {
  const result = profileMutationQueue.then(operation);
  profileMutationQueue = result.catch(() => {});
  return result;
}

/**
 * 把订阅模型目录同步成宿主模型档案。
 * @returns {Promise<{ok: boolean, added?: number, updated?: number, profiles?: number, error?: string, degraded?: boolean}>}
 */
async function syncProfilesIntoModelSettings(providerId, models, proxyInfo) {
  return withProfileMutation(() => syncProfilesIntoModelSettings0(providerId, models, proxyInfo));
}

async function syncProfilesIntoModelSettings0(providerId, models, proxyInfo) {
  const read = readExistingProfiles();
  if (!read.ok) return { ok: false, error: read.error };
  const plan = syncPlan(providerId, models, proxyInfo, read.settings);
  if (!plan) return { ok: false, error: "没有可同步的模型" };
  const { added, updated } = plan;
  const modelCount = selectableModels(plan.profile).length;

  // 1) 优先走渲染进程宿主 API（写盘 + 更新内存缓存，立即生效）
  const viaRenderer = await syncViaRenderer([plan]);
  if (viaRenderer.ok) {
    return { ...viaRenderer, added, updated, modelCount };
  }
  if (viaRenderer.incompatibleHost) return viaRenderer;

  // 2) 回退：直接写文件（需重启 Cyrene 生效）
  const fallback = writeProfilesToDisk([plan.profile]);
  if (!fallback.ok) return { ok: false, error: `${viaRenderer.error}；${fallback.error}` };
  return {
    ok: true,
    added,
    updated,
    modelCount,
    profiles: fallback.profiles,
    degraded: true,
    ...(plan.retired.length > 0 ? { migrationPending: true } : {}),
    warning: `${viaRenderer.error}，已直接写入渠道档案；重启 Cyrene 后生效${plan.retired.length > 0 ? "，旧会话与档案将在宿主窗口就绪后合并" : ""}`,
  };
}

/** 删除某订阅的全部 oauth 档案。 */
async function removeProfilesForProvider(providerId) {
  return withProfileMutation(() => removeProfilesForProvider0(providerId));
}

async function removeProfilesForProvider0(providerId) {
  if (!Object.hasOwn(PROVIDER_TRANSPORT, providerId)) return { ok: false, error: "未知订阅渠道" };
  const read = readExistingProfiles();
  if (!read.ok) return { ok: false, error: read.error };
  const ids = read.profiles.filter((p) => providerIdFromProfile(p) === providerId).map((p) => p.id);
  if (ids.length === 0) return { ok: true, removed: 0 };

  const viaRenderer = await deleteProfilesViaRenderer(ids);
  if (viaRenderer.ok) return { ok: true, removed: ids.length };

  // 回退：直接改文件
  const fs = require("node:fs");
  const settings = read.settings;
  settings.modelProfiles = read.profiles.filter((p) => providerIdFromProfile(p) !== providerId);
  if (ids.includes(settings.defaultModelProfileId)) {
    settings.defaultModelProfileId = settings.modelProfiles[0] && settings.modelProfiles[0].id;
  }
  try {
    fs.writeFileSync(modelSettingsPath(), JSON.stringify(settings, null, 2), "utf8");
  } catch (error) {
    return { ok: false, error: `${viaRenderer.error}；${error.message}` };
  }
  return { ok: true, removed: ids.length, degraded: true, warning: `${viaRenderer.error}，已直接修改配置文件，重启 Cyrene 后生效` };
}

module.exports = {
  PROFILE_PREFIX,
  PROVIDER_LABELS,
  PROVIDER_TRANSPORT,
  buildProfiles,
  reasoningFromModel,
  preferredProxyPortFromProfiles,
  rebindProfilesToProxyPort,
  refreshProfilesInHostCache,
  syncProfilesIntoModelSettings,
  removeProfilesForProvider,
};
