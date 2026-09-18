// TTS 设置面板交互：配置加载/保存、引擎切换、语速/音量滑块、
// MiniMax/GPT-SoVITS/自定义云端/MiMo/Mossland 测试发音、音色快速复刻
// 从 settings.ts 抽离。依赖 ttsState + TTS_FIELD_MAP + shared modal/utils。
// 副作用导入：模块加载时执行事件绑定 + 初始加载配置。

import { ttsState } from "./state";
import { TTS_FIELD_MAP, TTS_PROVIDER_FIELDS } from "./field-map";
import { DEFAULT_MOSSLAND_TTS_MODEL, type MosslandSyncFormat } from "../../../shared/tts-types";
import { createUniqueMiniMaxVoiceId, validateMiniMaxVoiceId } from "../../../shared/minimax-voice";
import { showHtmlModal, showNotice, showAlert } from "../shared/modal";
import { safeGet } from "../shared/utils";

/* ============================================================
   🎙️ TTS 设置面板交互
   - 配置加载/保存（存 general settings，跟其他设置一起）
   - 引擎选择卡片切换：选中哪个展开哪个配置表单
   - 语速/音量滑块实时显示数值 + 自动保存
   - MiniMax 测试发音：调 synthesize 合成固定文本并播放
   - 音色快速复刻：选文件→上传→训练→自动填入 voice_id
   ============================================================ */

interface TtsApi {
  upload: (apiKey: string, filePath: string, purpose: "voice_clone" | "prompt_audio") => Promise<{ file_id: string }>;
  pickAudio: () => Promise<string | null>;
  clone: (payload: {
    apiKey: string; fileId: string; voiceId: string;
    promptAudioId?: string; promptText?: string;
    text: string; model?: string;
  }) => Promise<{ voiceId: string; audioDemo?: string }>;
  synthesize: (payload: {
    apiKey: string; voiceId: string; text: string;
    speed?: number; volume?: number; pitch?: number;
    model?: string; format?: "mp3" | "wav" | "pcm";
  }) => Promise<string>; // base64 音频
  // GPT-SoVITS（返回 base64 + cacheKey + cached + format）
  synthesizeGptsovits: (payload: {
    baseUrl: string; refAudioPath: string; promptText: string; text: string;
    speed?: number; format?: "wav" | "mp3";
  }) => Promise<{ base64: string; cacheKey: string; cached: boolean; format: "wav" | "mp3" }>;
  synthesizeCachedGptsovits: (payload: {
    baseUrl: string; refAudioPath: string; promptText: string; text: string;
    speed?: number; format?: "wav" | "mp3";
    expectedCacheKey?: string;
  }) => Promise<{ base64: string; cacheKey: string; cached: boolean; format: "wav" | "mp3" }>;
  // 自定义云端（返回 base64 + cacheKey + cached + format）
  synthesizeCustomCloud: (payload: {
    endpointUrl: string; apiKey?: string; voiceId?: string; text: string;
    speed?: number; volume?: number; format?: "wav" | "mp3"; timeoutMs?: number;
  }) => Promise<{ base64: string; cacheKey: string; cached: boolean; format: "wav" | "mp3" }>;
  synthesizeCachedCustomCloud: (payload: {
    endpointUrl: string; apiKey?: string; voiceId?: string; text: string;
    speed?: number; volume?: number; format?: "wav" | "mp3"; timeoutMs?: number;
    expectedCacheKey?: string;
  }) => Promise<{ base64: string; cacheKey: string; cached: boolean; format: "wav" | "mp3" }>;
  // 小米 MiMo（返回 base64 + cacheKey + cached + format）
  synthesizeMimo: (payload: {
    apiKey: string; voiceAudioPath?: string; text: string; stylePrompt?: string;
  }) => Promise<{ base64: string; cacheKey: string; cached: boolean; format: "wav" }>;
  synthesizeCachedMimo: (payload: {
    apiKey: string; voiceAudioPath?: string; text: string; stylePrompt?: string;
    expectedCacheKey?: string;
  }) => Promise<{ base64: string; cacheKey: string; cached: boolean; format: "wav" }>;
  // Mossland（api.mosi.cn）
  synthesizeMossland: (payload: {
    apiKey: string; voiceId: string; text: string;
    model?: string; format?: MosslandSyncFormat;
  }) => Promise<{ base64: string; cacheKey: string; cached: boolean; format: MosslandSyncFormat }>;
  synthesizeCachedMossland: (payload: {
    apiKey: string; voiceId: string; text: string;
    model?: string; format?: MosslandSyncFormat;
    expectedCacheKey?: string;
  }) => Promise<{ base64: string; cacheKey: string; cached: boolean; format: MosslandSyncFormat }>;
  cloneMossland: (payload: {
    apiKey: string; filePath: string; name?: string; description?: string;
  }) => Promise<{ voiceId: string; name?: string; createdAt?: number }>;
  listMosslandVoices: (payload: {
    apiKey: string; limit?: number; offset?: number; after?: string; status?: string;
  }) => Promise<{
    voices: Array<{ id: string; name: string; createdAt: number }>;
    hasMore: boolean;
    nextCursor?: string;
  }>;
  pickAudioFile: () => Promise<string | null>;
  saveSettings: (tts: Record<string, unknown>) => Promise<unknown>;
  loadSettings: () => Promise<Record<string, unknown>>;
}

declare global {
  interface Window {
    tts?: TtsApi;
  }
}

const TTS_TEST_TEXT = "你好，我是昔涟，很高兴见到你。";

// 获取 DOM 元素的辅助函数
function ttsEl(id: string): HTMLInputElement {
  return document.getElementById(id) as HTMLInputElement;
}

// 切分模式按钮组：按 data-value 同步 is-active 与 aria-pressed
function applySplitModeSelection(mode: "sentence" | "paragraph"): void {
  const group = document.getElementById("tts-early-read-split-mode");
  if (!group) return;
  group.querySelectorAll<HTMLButtonElement>(".option-block").forEach((button) => {
    const active = button.dataset.value === mode;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  });
}

// 切分模式按钮组：整体禁用/启用
function setSplitModeDisabled(disabled: boolean): void {
  const group = document.getElementById("tts-early-read-split-mode");
  if (!group) return;
  group.querySelectorAll<HTMLButtonElement>(".option-block").forEach((button) => {
    button.disabled = disabled;
  });
}

// 当前加载的 TTS 配置（内存缓存，改一个字段就存一次）

// 加载配置并填充表单
async function loadTtsConfig(): Promise<void> {
  if (!window.tts) return;
  try {
    ttsState.config = await window.tts.loadSettings() as Record<string, unknown>;
  } catch (err) {
    console.warn("[TTS] 加载配置失败:", err);
    return;
  }

  // 引擎选择
  const engine = String(ttsState.config.ttsEngine || "off");
  document.querySelectorAll<HTMLButtonElement>(".tts-engine").forEach((btn) => {
    const isActive = btn.dataset.engine === engine;
    btn.classList.toggle("is-active", isActive);
    btn.setAttribute("aria-checked", isActive ? "true" : "false");
  });
  document.querySelectorAll<HTMLElement>(".tts-config").forEach((el) => { el.hidden = true; });
  if (engine !== "off") {
    const config = document.getElementById("tts-config-" + engine);
    if (config) config.hidden = false;
  }

  // 播放交互
  ttsEl("tts-auto-read").checked = Boolean(ttsState.config.ttsAutoRead);
  ttsEl("tts-speed").value = String(ttsState.config.ttsSpeed ?? 1);
  ttsEl("tts-volume").value = String(ttsState.config.ttsVolume ?? 1);
  // 自动朗读文本切分开关 + 切分模式按钮组（关闭时置灰按钮组）
  const splitEnabled = ttsState.config.ttsEarlyReadSplitEnabled !== false;
  ttsEl("tts-early-read-split-enabled").checked = splitEnabled;
  applySplitModeSelection(ttsState.config.ttsEarlyReadSplitMode === "paragraph" ? "paragraph" : "sentence");
  setSplitModeDisabled(!splitEnabled);
  updateTtsSliderLabels();

  // MiniMax
  ttsEl("tts-minimax-key").value = String(ttsState.config.ttsMinimaxKey ?? "");
  ttsEl("tts-minimax-voice").value = String(ttsState.config.ttsMinimaxVoiceId ?? "");
  (ttsEl("tts-minimax-model") as HTMLSelectElement).value =
    ttsState.config.ttsMinimaxModel === "speech-2.8-hd" ? "speech-2.8-hd" : "speech-2.8-turbo";
  ttsEl("tts-streaming").checked = ttsState.config.ttsStreaming !== false;
  ttsEl("tts-minimax-vocal-enhance").checked = ttsState.config.ttsMinimaxVocalEnhance !== false;

  // GPT-SoVITS
  ttsEl("tts-gptsovits-url").value = String(ttsState.config.ttsGptsovitsBaseUrl ?? "http://localhost:9880");
  ttsEl("tts-gptsovits-ref-audio").value = String(ttsState.config.ttsGptsovitsRefAudioPath ?? "");
  ttsEl("tts-gptsovits-prompt-text").value = String(ttsState.config.ttsGptsovitsPromptText ?? "");
  (ttsEl("tts-gptsovits-format") as HTMLSelectElement).value =
    ttsState.config.ttsGptsovitsFormat === "mp3" ? "mp3" : "wav";
  ttsEl("tts-gptsovits-timeout").value = String(ttsState.config.ttsGptsovitsTimeoutMs ?? 180000);

  // 自定义云端
  ttsEl("tts-custom-cloud-url").value = String(ttsState.config.ttsCustomCloudEndpointUrl ?? "");
  ttsEl("tts-custom-cloud-key").value = String(ttsState.config.ttsCustomCloudApiKey ?? "");
  ttsEl("tts-custom-cloud-voice").value = String(ttsState.config.ttsCustomCloudVoiceId ?? "");
  (ttsEl("tts-custom-cloud-format") as HTMLSelectElement).value =
    ttsState.config.ttsCustomCloudFormat === "wav" ? "wav" : "mp3";
  ttsEl("tts-custom-cloud-timeout").value = String(ttsState.config.ttsCustomCloudTimeoutMs ?? 30000);

  // 小米 MiMo
  ttsEl("tts-mimo-key").value = String(ttsState.config.ttsMimoKey ?? "");
  ttsEl("tts-mimo-voice-audio").value = String(ttsState.config.ttsMimoVoiceAudioPath ?? "");
  ttsEl("tts-mimo-style").value = String(ttsState.config.ttsMimoStylePrompt ?? "温柔、自然、略带亲近感，像在轻声陪用户聊天。");

  // Mossland（UI 骨架已就位，IPC 第二步接通；字段值已写入 ttsState.config 以便保存）
  ttsEl("tts-mossland-key").value = String(ttsState.config.ttsMosslandKey ?? "");
  ttsEl("tts-mossland-voice").value = String(ttsState.config.ttsMosslandVoiceId ?? "");
  const mosslandModelSelect = ttsEl("tts-mossland-model") as HTMLSelectElement;
  const rawMosslandModel = String(ttsState.config.ttsMosslandModel ?? "").trim();
  const savedMosslandModel = rawMosslandModel && rawMosslandModel !== "moss-tts"
    ? rawMosslandModel
    : DEFAULT_MOSSLAND_TTS_MODEL;
  if (![...mosslandModelSelect.options].some((option) => option.value === savedMosslandModel)) {
    const savedOption = document.createElement("option");
    savedOption.value = savedMosslandModel;
    savedOption.textContent = `${savedMosslandModel}（已保存版本）`;
    mosslandModelSelect.appendChild(savedOption);
  }
  mosslandModelSelect.value = savedMosslandModel;
  ttsEl("tts-mossland-text").value = String(ttsState.config.ttsMosslandTestText ?? TTS_TEST_TEXT);
  (ttsEl("tts-mossland-format") as HTMLSelectElement).value =
    ttsState.config.ttsMosslandFormat === "wav" ? "wav" : "mp3";
  ttsState.config.ttsMosslandKey       = String(ttsEl("tts-mossland-key").value);
  ttsState.config.ttsMosslandVoiceId   = String(ttsEl("tts-mossland-voice").value);
  ttsState.config.ttsMosslandModel     = (ttsEl("tts-mossland-model") as HTMLSelectElement).value;
  ttsState.config.ttsMosslandTestText  = String(ttsEl("tts-mossland-text").value);
  ttsState.config.ttsMosslandFormat    = (ttsEl("tts-mossland-format") as HTMLSelectElement).value;

  // 加载完成后清掉所有 Provider 的脏态（按钮隐藏，status 清空）
  for (const provider of Object.keys(TTS_PROVIDER_FIELDS)) {
    const ui = ttsProviderUi[provider];
    if (!ui) continue;
    ui.btn.classList.add("is-hidden");
    ui.status.textContent = "";
  }
}

function updateTtsSliderLabels(): void {
  const speedVal = document.getElementById("tts-speed-val");
  const volVal = document.getElementById("tts-volume-val");
  if (speedVal) speedVal.textContent = Number(ttsEl("tts-speed").value).toFixed(1) + "x";
  if (volVal) volVal.textContent = Math.round(Number(ttsEl("tts-volume").value) * 100) + "%";
}

// 保存单个 TTS 配置字段
async function saveTtsField(field: string, value: unknown): Promise<void> {
  if (!window.tts) return;
  ttsState.config[field] = value;
  try {
    await window.tts.saveSettings({ [field]: value });
  } catch (err) {
    console.warn("[TTS] 保存配置失败:", field, err);
  }
}

// 播放 base64 音频。format 决定 Blob MIME（minimax 默认 mp3，gptsovits 默认 wav）
function playTtsAudio(base64: string, format: "wav" | "mp3" = "mp3"): void {
  try {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const mime = format === "wav" ? "audio/wav" : "audio/mp3";
    const blob = new Blob([bytes], { type: mime });
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    audio.play().catch((err) => console.warn("[TTS] 播放失败:", err));
    audio.onended = () => URL.revokeObjectURL(url);
  } catch (err) {
    console.warn("[TTS] 音频解码失败:", err);
  }
}

// 引擎选择切换
// 只匹配带 data-engine 的按钮（即 TTS 厂商按钮）——主动开口档位按钮虽然
// 共用 .tts-engine 视觉 class，但只有 data-mode 没有 data-engine，
// 用属性选择器避免误触把它们当作 TTS 厂商处理。
document.querySelectorAll<HTMLButtonElement>("[data-engine]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const engine = btn.dataset.engine || "off";
    document.querySelectorAll<HTMLButtonElement>("[data-engine]").forEach((b) => {
      b.classList.remove("is-active");
      b.setAttribute("aria-checked", "false");
    });
    btn.classList.add("is-active");
    btn.setAttribute("aria-checked", "true");
    document.querySelectorAll<HTMLElement>(".tts-config").forEach((el) => { el.hidden = true; });
    if (engine !== "off") {
      const config = document.getElementById("tts-config-" + engine);
      if (config) config.hidden = false;
    }
    void saveTtsField("ttsEngine", engine);
  });
});

// 自动朗读开关
ttsEl("tts-auto-read").addEventListener("change", () => {
  void saveTtsField("ttsAutoRead", ttsEl("tts-auto-read").checked);
});

// 自动朗读文本切分开关（关闭时禁用切分模式按钮组并立即保存）
ttsEl("tts-early-read-split-enabled").addEventListener("change", () => {
  const enabled = ttsEl("tts-early-read-split-enabled").checked;
  setSplitModeDisabled(!enabled);
  void saveTtsField("ttsEarlyReadSplitEnabled", enabled);
});

// 语速/音量滑块（change 时保存，input 时实时显示）
ttsEl("tts-speed").addEventListener("input", updateTtsSliderLabels);
ttsEl("tts-speed").addEventListener("change", () => saveTtsField("ttsSpeed", Number(ttsEl("tts-speed").value)));
ttsEl("tts-volume").addEventListener("input", updateTtsSliderLabels);
ttsEl("tts-volume").addEventListener("change", () => saveTtsField("ttsVolume", Number(ttsEl("tts-volume").value)));

// 自动朗读文本切分模式（点击按钮即时保存并切换高亮）
const splitModeGroup = document.getElementById("tts-early-read-split-mode");
splitModeGroup?.querySelectorAll<HTMLButtonElement>(".option-block").forEach((button) => {
  button.addEventListener("click", () => {
    if (button.disabled) return;
    const mode = button.dataset.value === "paragraph" ? "paragraph" : "sentence";
    applySplitModeSelection(mode);
    void saveTtsField("ttsEarlyReadSplitMode", mode);
  });
});

// GPT-SoVITS 超时输入框（number，blur 时保存并做简单边界限制）
ttsEl("tts-gptsovits-timeout").addEventListener("change", () => {
  let value = Number(ttsEl("tts-gptsovits-timeout").value);
  if (!Number.isFinite(value) || value < 10000) value = 10000;
  if (value > 3600000) value = 3600000;
  ttsEl("tts-gptsovits-timeout").value = String(value);
  void saveTtsField("ttsGptsovitsTimeoutMs", value);
});

// ── TTS 文本输入框：按 Provider 分组 + 手动保存 ──
// 之前这里有 input/change 自动 saveTtsField（settings.ts:4270–4295），
// 但每次 input 都会触发 IPC，IME 组字过程会被打断，用户反馈"打着打着输入法被打断"。
// 现在改为：文本框只 mark dirty，真正保存只发生在用户点击 Provider 自己的"保存配置"按钮。
// switch / slider / select / 引擎选择 / Opener 档位仍然走立即保存（保持即时反馈）。

// Provider ID → { 保存按钮, 状态 div }
// 用 ttsEl() 安全获取：拿不到时返回 null，不让整个 settings.ts 初始化崩。
const ttsProviderUi: Record<string, { btn: HTMLButtonElement; status: HTMLElement } | null> = {
  minimax:        ttsEl("tts-minimax-save-btn") && safeGet("tts-minimax-save-status")
                    ? { btn: ttsEl("tts-minimax-save-btn"), status: safeGet("tts-minimax-save-status") as HTMLElement }
                    : null,
  gptsovits:      ttsEl("tts-gptsovits-save-btn") && safeGet("tts-gptsovits-save-status")
                    ? { btn: ttsEl("tts-gptsovits-save-btn"), status: safeGet("tts-gptsovits-save-status") as HTMLElement }
                    : null,
  "custom-cloud": ttsEl("tts-custom-cloud-save-btn") && safeGet("tts-custom-cloud-save-status")
                    ? { btn: ttsEl("tts-custom-cloud-save-btn"), status: safeGet("tts-custom-cloud-save-status") as HTMLElement }
                    : null,
  mimo:           ttsEl("tts-mimo-save-btn") && safeGet("tts-mimo-save-status")
                    ? { btn: ttsEl("tts-mimo-save-btn"), status: safeGet("tts-mimo-save-status") as HTMLElement }
                    : null,
  mossland:       ttsEl("tts-mossland-save-btn") && safeGet("tts-mossland-save-status")
                    ? { btn: ttsEl("tts-mossland-save-btn"), status: safeGet("tts-mossland-save-status") as HTMLElement }
                    : null,
};

// 输入框触发脏态：只显示按钮和"有未保存的更改"，不发 IPC
function markTtsProviderDirty(provider: string): void {
  const ui = ttsProviderUi[provider];
  if (!ui) return;
  ui.btn.classList.remove("is-hidden");
  ui.status.textContent = "有未保存的更改";
  ui.status.className = "save-status";
}

for (const [provider, elIds] of Object.entries(TTS_PROVIDER_FIELDS)) {
  for (const elId of elIds) {
    const el = ttsEl(elId);
    el.addEventListener("input", () => markTtsProviderDirty(provider));
  }
}

// 保存某个 Provider 的所有文本配置
async function saveTtsProvider(provider: string): Promise<void> {
  const ui = ttsProviderUi[provider];
  if (!ui) return;
  const fields = TTS_PROVIDER_FIELDS[provider] ?? [];
  ui.btn.disabled = true;
  ui.status.textContent = "保存中…";
  ui.status.className = "save-status";
  try {
    const payload: Record<string, unknown> = {};
    for (const elId of fields) {
      const field = TTS_FIELD_MAP[elId];
      if (!field) continue;
      const el = ttsEl(elId);
      // 数字字段（timeout）转 Number；无效则跳过该字段但继续保存其他字段
      let value: unknown = el.value;
      if (elId === "tts-custom-cloud-timeout") {
        const num = Number(el.value);
        if (!Number.isFinite(num) || num <= 0) continue;
        value = num;
      }
      payload[field] = value;
      ttsState.config[field] = value;   // 同步内存中的 ttsState.config 缓存
    }
    if (Object.keys(payload).length === 0) {
      ui.status.textContent = "没有可保存的更改";
      ui.status.className = "save-status";
      return;
    }
    await window.tts!.saveSettings(payload);
    ui.status.textContent = "已保存";
    ui.status.className = "save-status is-ok";
    ui.btn.classList.add("is-hidden");
    setTimeout(() => { ui.status.textContent = ""; }, 2000);
  } catch (e) {
    ui.status.textContent = "保存失败：" + (e instanceof Error ? e.message : String(e));
    ui.status.className = "save-status is-error";
  } finally {
    ui.btn.disabled = false;
  }
}

// 注册点击 handler
for (const [provider, ui] of Object.entries(ttsProviderUi)) {
  ui?.btn.addEventListener("click", () => void saveTtsProvider(provider));
}

// GPT-SoVITS 格式选择（select，change 时直接保存）
(ttsEl("tts-gptsovits-format") as HTMLSelectElement).addEventListener("change", () => {
  void saveTtsField("ttsGptsovitsFormat", (ttsEl("tts-gptsovits-format") as HTMLSelectElement).value as "wav" | "mp3");
});

// 自定义云端格式选择
(ttsEl("tts-custom-cloud-format") as HTMLSelectElement).addEventListener("change", () => {
  void saveTtsField("ttsCustomCloudFormat", (ttsEl("tts-custom-cloud-format") as HTMLSelectElement).value as "wav" | "mp3");
});

// MiniMax 合成模型属于 select：切换即保存，不依赖 Provider 文本字段的“保存配置”按钮。
(ttsEl("tts-minimax-model") as HTMLSelectElement).addEventListener("change", () => {
  const value = (ttsEl("tts-minimax-model") as HTMLSelectElement).value;
  void saveTtsField("ttsMinimaxModel", value === "speech-2.8-hd" ? "speech-2.8-hd" : "speech-2.8-turbo");
});

// MiniMax 流式播放开关
ttsEl("tts-streaming").addEventListener("change", () => {
  void saveTtsField("ttsStreaming", ttsEl("tts-streaming").checked);
});

// MiniMax 语音增强开关
ttsEl("tts-minimax-vocal-enhance").addEventListener("change", () => {
  void saveTtsField("ttsMinimaxVocalEnhance", ttsEl("tts-minimax-vocal-enhance").checked);
});

// GPT-SoVITS 选择参考音频
document.getElementById("tts-gptsovits-ref-pick")?.addEventListener("click", async () => {
  if (!window.tts) return;
  const filePath = await window.tts.pickAudioFile();
  if (filePath) {
    ttsEl("tts-gptsovits-ref-audio").value = filePath;
    void saveTtsField("ttsGptsovitsRefAudioPath", filePath);
  }
});

// GPT-SoVITS 测试发音
document.getElementById("tts-gptsovits-test")?.addEventListener("click", async () => {
  if (!window.tts) return;
  const baseUrl = ttsEl("tts-gptsovits-url").value.trim();
  const refAudioPath = ttsEl("tts-gptsovits-ref-audio").value.trim();
  const promptText = ttsEl("tts-gptsovits-prompt-text").value.trim();
  const format = (ttsEl("tts-gptsovits-format") as HTMLSelectElement).value as "wav" | "mp3";
  // 字段校验用非阻塞轻提示；文件路径为只读回填，焦点交给相邻选择按钮
  if (!baseUrl) { showNotice({ tone: "warning", message: "请先填写 GPT-SoVITS API 地址", focusTarget: ttsEl("tts-gptsovits-url") }); return; }
  if (!refAudioPath) { showNotice({ tone: "warning", message: "请先选择参考音频文件" }); return; }
  if (!promptText) { showNotice({ tone: "warning", message: "请先填写参考音频对应的文本", focusTarget: ttsEl("tts-gptsovits-prompt-text") }); return; }

  const btn = document.getElementById("tts-gptsovits-test") as HTMLButtonElement;
  btn.disabled = true;
  btn.textContent = "合成中…";
  try {
    const result = await window.tts.synthesizeGptsovits({
      baseUrl, refAudioPath, promptText, text: TTS_TEST_TEXT, format,
    });
    playTtsAudio(result.base64, result.format);
  } catch (err) {
    // 异常详情可能需要阅读：单按钮错误模态框
    await showAlert({
      tone: "error",
      title: "测试失败",
      message: "合成请求未能完成，请检查配置后重试。",
      details: err instanceof Error ? err.message : String(err),
    });
  } finally {
    btn.disabled = false;
    btn.textContent = "🔊 测试发音";
  }
});

// 小米 MiMo 选择昔涟克隆参考音频
document.getElementById("tts-mimo-voice-pick")?.addEventListener("click", async () => {
  if (!window.tts) return;
  const filePath = await window.tts.pickAudioFile();
  if (filePath) {
    ttsEl("tts-mimo-voice-audio").value = filePath;
    void saveTtsField("ttsMimoVoiceAudioPath", filePath);
  }
});

// 自定义云端测试发音
document.getElementById("tts-custom-cloud-test")?.addEventListener("click", async () => {
  if (!window.tts) return;
  const endpointUrl = ttsEl("tts-custom-cloud-url").value.trim();
  const apiKey = ttsEl("tts-custom-cloud-key").value.trim();
  const voiceId = ttsEl("tts-custom-cloud-voice").value.trim();
  const format = (ttsEl("tts-custom-cloud-format") as HTMLSelectElement).value as "wav" | "mp3";
  const timeoutMs = Number(ttsEl("tts-custom-cloud-timeout").value) || 30000;
  if (!endpointUrl) { showNotice({ tone: "warning", message: "请先填写自定义云端 Endpoint URL", focusTarget: ttsEl("tts-custom-cloud-url") }); return; }

  const btn = document.getElementById("tts-custom-cloud-test") as HTMLButtonElement;
  btn.disabled = true;
  btn.textContent = "合成中…";
  try {
    const result = await window.tts.synthesizeCustomCloud({
      endpointUrl, apiKey, voiceId, text: TTS_TEST_TEXT,
      speed: Number(ttsEl("tts-speed").value),
      volume: Number(ttsEl("tts-volume").value),
      format,
      timeoutMs,
    });
    playTtsAudio(result.base64, result.format);
  } catch (err) {
    // 异常详情可能需要阅读：单按钮错误模态框
    await showAlert({
      tone: "error",
      title: "测试失败",
      message: "自定义云端合成请求未能完成，请检查配置后重试。",
      details: err instanceof Error ? err.message : String(err),
    });
  } finally {
    btn.disabled = false;
    btn.textContent = "🔊 测试发音";
  }
});

// 小米 MiMo 测试发音
document.getElementById("tts-mimo-test")?.addEventListener("click", async () => {
  if (!window.tts) return;
  const apiKey = ttsEl("tts-mimo-key").value.trim();
  const voiceAudioPath = ttsEl("tts-mimo-voice-audio").value.trim();
  const stylePrompt = ttsEl("tts-mimo-style").value.trim();
  if (!apiKey) { showNotice({ tone: "warning", message: "请先填写小米 MiMo API Key", focusTarget: ttsEl("tts-mimo-key") }); return; }
  // 音频路径为只读回填，焦点交给相邻选择按钮
  if (!voiceAudioPath) { showNotice({ tone: "warning", message: "请先选择昔涟克隆参考音频" }); return; }

  const btn = document.getElementById("tts-mimo-test") as HTMLButtonElement;
  btn.disabled = true;
  btn.textContent = "合成中…";
  try {
    const result = await window.tts.synthesizeMimo({
      apiKey, voiceAudioPath, stylePrompt, text: TTS_TEST_TEXT,
    });
    playTtsAudio(result.base64, result.format);
  } catch (err) {
    // 异常详情可能需要阅读：单按钮错误模态框
    await showAlert({
      tone: "error",
      title: "测试失败",
      message: "小米 MiMo 合成请求未能完成，请检查配置后重试。",
      details: err instanceof Error ? err.message : String(err),
    });
  } finally {
    btn.disabled = false;
    btn.textContent = "🔊 测试发音";
  }
});

// ── Mossland ──
// 当前为 UI 骨架：所有按钮触发"功能开发中"占位 modal，
// ── Mossland ──
// 第二步已接通：所有按钮走真实 IPC 调用，错误抛到 status / alert。
function setMosslandStatus(text: string, type: "ok" | "error" | "loading"): void {
  const el = document.getElementById("tts-mossland-clone-status");
  if (!el) return;
  el.textContent = text;
  el.className = "tts-clone-status" + (type ? " is-" + type : "");
}

function setMosslandListStatus(text: string, type: "ok" | "error" | "loading"): void {
  const el = document.getElementById("tts-mossland-list-voices-status");
  if (!el) return;
  el.textContent = text;
  el.className = "tts-clone-status" + (type ? " is-" + type : "");
}

/** 把拉到的 voices 列表渲染成 `<ul>`；每行有一个"使用此 voice"按钮，点击回填到 #tts-mossland-voice */
function renderMosslandVoiceList(voices: Array<{ id: string; name: string }>): void {
  const ul = document.getElementById("tts-mossland-voice-list");
  if (!ul) return;
  ul.replaceChildren();
  for (const v of voices) {
    const li = document.createElement("li");
    const idSpan = document.createElement("span");
    idSpan.className = "voice-id";
    idSpan.textContent = v.id;
    const nameSpan = document.createElement("span");
    nameSpan.className = "voice-name";
    nameSpan.textContent = v.name;
    const useBtn = document.createElement("button");
    useBtn.type = "button";
    useBtn.className = "voice-use";
    useBtn.textContent = "使用";
    useBtn.addEventListener("click", () => {
      ttsEl("tts-mossland-voice").value = v.id;
    });
    li.append(idSpan, nameSpan, useBtn);
    ul.appendChild(li);
  }
}

// 测试发音：走 window.tts.synthesizeMossland
document.getElementById("tts-mossland-test")?.addEventListener("click", async () => {
  if (!window.tts) return;
  const apiKey = ttsEl("tts-mossland-key").value.trim();
  const voiceId = ttsEl("tts-mossland-voice").value.trim();
  const text = ttsEl("tts-mossland-text").value.trim();
  const model = (ttsEl("tts-mossland-model") as HTMLSelectElement).value;
  const format = (ttsEl("tts-mossland-format") as HTMLSelectElement).value as MosslandSyncFormat;
  if (!apiKey) { showNotice({ tone: "warning", message: "请先填写 Mossland API Key", focusTarget: ttsEl("tts-mossland-key") }); return; }
  if (!voiceId) { showNotice({ tone: "warning", message: "请先填写音色 ID（可从下方拉取列表）", focusTarget: ttsEl("tts-mossland-voice") }); return; }
  if (!text) { showNotice({ tone: "warning", message: "请先填写试听文本", focusTarget: ttsEl("tts-mossland-text") }); return; }

  const btn = document.getElementById("tts-mossland-test") as HTMLButtonElement;
  btn.disabled = true;
  btn.textContent = "合成中…";
  const statusEl = document.getElementById("tts-mossland-test-status");
  if (statusEl) { statusEl.textContent = "合成中…"; statusEl.className = "tts-clone-status is-loading"; }
  try {
    const result = await window.tts.synthesizeMossland({ apiKey, voiceId, text, model, format });
    playTtsAudio(result.base64, result.format);
    if (statusEl) {
      statusEl.textContent = "✅ 合成成功";
      statusEl.className = "tts-clone-status is-ok";
      setTimeout(() => { statusEl.textContent = ""; }, 2000);
    }
  } catch (err) {
    if (statusEl) {
      statusEl.textContent = "❌ " + (err instanceof Error ? err.message : String(err));
      statusEl.className = "tts-clone-status is-error";
    } else {
      // 异常详情可能需要阅读：单按钮错误模态框
      await showAlert({
        tone: "error",
        title: "合成失败",
        message: "Mossland 合成请求未能完成，请检查配置后重试。",
        details: err instanceof Error ? err.message : String(err),
      });
    }
  } finally {
    btn.disabled = false;
    btn.textContent = "测试发音";
  }
});


// 克隆子区块：选择文件（用现有 pickAudio）
document.getElementById("tts-mossland-clone-pick")?.addEventListener("click", async () => {
  if (!window.tts) return;
  const filePath = await window.tts.pickAudio();
  if (filePath) ttsEl("tts-mossland-clone-file").value = filePath;
});

// 克隆子区块：开始上传（multipart）
document.getElementById("tts-mossland-clone-start")?.addEventListener("click", async () => {
  if (!window.tts) return;
  const apiKey = ttsEl("tts-mossland-key").value.trim();
  const filePath = ttsEl("tts-mossland-clone-file").value.trim();
  const name = ttsEl("tts-mossland-clone-name").value.trim();
  const description = ttsEl("tts-mossland-clone-desc").value.trim();
  if (!apiKey) { showNotice({ tone: "warning", message: "请先填写 Mossland API Key", focusTarget: ttsEl("tts-mossland-key") }); return; }
  // 音频路径为只读回填，焦点交给相邻选择按钮
  if (!filePath) { showNotice({ tone: "warning", message: "请先选择参考音频" }); return; }

  setMosslandStatus("正在上传并创建音色…", "loading");
  try {
    const result = await window.tts.cloneMossland({
      apiKey, filePath,
      name: name || undefined,
      description: description || undefined,
    });
    // 自动填到上方「音色 ID」+ 同步写到 ttsState.config（让保存按钮 / chat 调度都能用）
    ttsEl("tts-mossland-voice").value = result.voiceId;
    void saveTtsField("ttsMosslandVoiceId", result.voiceId);
    setMosslandStatus(`✅ 克隆成功！voice_id「${result.voiceId}」已自动填入音色 ID 框。`, "ok");
  } catch (err) {
    setMosslandStatus("❌ " + (err instanceof Error ? err.message : String(err)), "error");
  }
});

// 拉取音色列表：调 listMosslandVoices + 渲染
document.getElementById("tts-mossland-list-voices")?.addEventListener("click", async () => {
  if (!window.tts) return;
  const apiKey = ttsEl("tts-mossland-key").value.trim();
  if (!apiKey) { showNotice({ tone: "warning", message: "请先填写 Mossland API Key", focusTarget: ttsEl("tts-mossland-key") }); return; }

  setMosslandListStatus("正在拉取音色列表…", "loading");
  try {
    const result = await window.tts.listMosslandVoices({ apiKey, limit: 150 });
    if (result.voices.length === 0) {
      setMosslandListStatus("账号下还没有已克隆的音色，请先到上方「音色克隆」创建一个。", "error");
    } else {
      renderMosslandVoiceList(result.voices);
      const moreHint = result.hasMore ? "仍有更多音色，可稍后继续分页拉取。" : "";
      setMosslandListStatus(`✅ 拉到 ${result.voices.length} 个音色。点击右侧「使用」可填入音色 ID 框。${moreHint}`, "ok");
    }
  } catch (err) {
    setMosslandListStatus("❌ " + (err instanceof Error ? err.message : String(err)), "error");
  }
});

// 克隆须知 modal（富文本，复用 showHtmlModal 复用 MiniMax 那套样式）
document.getElementById("tts-mossland-clone-info-btn")?.addEventListener("click", () => {
  void showHtmlModal({
    title: "Mossland 音色克隆 · 完整规格",
    icon: "ⓘ",
    htmlBody: [
      '<div class="tts-clone-spec-block">',
      '  <h4>音色管理</h4>',
      '  <p>创建成功后会返回 <code>voice_id</code>。有效期、计费和账号配额请以 Mossland 控制台的当前说明为准。</p>',
      '</div>',
      '<div class="tts-clone-spec-block">',
      '  <h4><svg class="tts-clone-spec-icon" width="18" height="18" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M8 44V4H31L40 14.5V44H8Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M32 14L26 16.9688V31.5" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><circle cx="20.5" cy="31.5" r="5.5" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg> 参考音频 <code>audio_sample</code></h4>',
      '  <ul>',
      '    <li>请求格式：<strong>multipart/form-data</strong>（不支持 JSON / URL / base64）</li>',
      '    <li>字段名：<code>audio_sample</code>（必填）</li>',
      '    <li>字段名：<code>name</code>（可选，给音色起名）</li>',
      '    <li>字段名：<code>description</code>（可选，描述音色）</li>',
      '    <li>请上传清晰、单人、低噪声的参考音频；格式和大小限制以接口返回为准</li>',
      '  </ul>',
      '</div>',
      '<div class="tts-clone-spec-block">',
      '  <h4><svg class="tts-clone-spec-icon" width="18" height="18" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><circle cx="24" cy="24" r="18" fill="none" stroke="currentColor" stroke-width="4"/><path d="M24 14V16" stroke="currentColor" stroke-width="4" stroke-linecap="round"/><circle cx="24" cy="32" r="2.5" fill="currentColor"/></svg> 后续合成</h4>',
      '  <ul>',
      '    <li>拿到 voice_id 后，调用 <code>POST /v1/audio/speech</code></li>',
      '    <li>同步合成可选择 <code>moss-tts-1.5-flash</code> 或 <code>moss-tts-1.0-pro</code>，输出 MP3 / WAV</li>',
      '  </ul>',
      '</div>',
    ].join("\n"),
  });
});

// MiniMax 测试发音
document.getElementById("tts-minimax-test")?.addEventListener("click", async () => {
  if (!window.tts) return;
  const apiKey = ttsEl("tts-minimax-key").value.trim();
  const voiceId = ttsEl("tts-minimax-voice").value.trim();
  const modelSelect = ttsEl("tts-minimax-model") as HTMLSelectElement;
  const model = modelSelect.value === "speech-2.8-hd" ? "speech-2.8-hd" : "speech-2.8-turbo";
  if (!apiKey) { showNotice({ tone: "warning", message: "请先填写 MiniMax API Key", focusTarget: ttsEl("tts-minimax-key") }); return; }
  if (!voiceId) { showNotice({ tone: "warning", message: "请先填写音色 ID（或下方复刻训练）", focusTarget: ttsEl("tts-minimax-voice") }); return; }

  const btn = document.getElementById("tts-minimax-test") as HTMLButtonElement;
  btn.disabled = true;
  btn.textContent = "合成中…";
  try {
    const vocalEnhance = { enabled: ttsEl("tts-minimax-vocal-enhance").checked };
    const base64 = await window.tts.synthesize({ apiKey, voiceId, text: TTS_TEST_TEXT, model, vocalEnhance });
    playTtsAudio(base64);
  } catch (err) {
    // 异常详情可能需要阅读：单按钮错误模态框
    await showAlert({
      tone: "error",
      title: "测试失败",
      message: "MiniMax 合成请求未能完成，请检查配置后重试。",
      details: err instanceof Error ? err.message : String(err),
    });
  } finally {
    btn.disabled = false;
    btn.textContent = "🔊 测试发音";
  }
});

// ── 音色快速复刻 ──
// 选择配音文件
document.getElementById("tts-clone-pick")?.addEventListener("click", async () => {
  if (!window.tts) return;
  const filePath = await window.tts.pickAudio();
  if (filePath) ttsEl("tts-clone-file").value = filePath;
});

// 选择示例音频
document.getElementById("tts-clone-prompt-pick")?.addEventListener("click", async () => {
  if (!window.tts) return;
  const filePath = await window.tts.pickAudio();
  if (filePath) ttsEl("tts-clone-prompt-file").value = filePath;
});

// 设置复刻状态文案
function setCloneStatus(text: string, type: "ok" | "error" | "loading"): void {
  const el = document.getElementById("tts-clone-status");
  if (!el) return;
  el.textContent = text;
  el.className = "tts-clone-status" + (type ? " is-" + type : "");
}

// 开始复刻
document.getElementById("tts-clone-start")?.addEventListener("click", async () => {
  if (!window.tts) return;
  const apiKey = ttsEl("tts-minimax-key").value.trim();
  const cloneFile = ttsEl("tts-clone-file").value.trim();
  const promptFile = ttsEl("tts-clone-prompt-file").value.trim();
  const promptText = ttsEl("tts-clone-prompt-text").value.trim();
  const cloneText = ttsEl("tts-clone-text").value.trim();
  const voiceId = ttsEl("tts-clone-voice-id").value.trim();

  if (!apiKey) { showNotice({ tone: "warning", message: "请先填写 MiniMax API Key", focusTarget: ttsEl("tts-minimax-key") }); return; }
  // 配音文件为只读回填，焦点交给相邻选择按钮
  if (!cloneFile) { showNotice({ tone: "warning", message: "请选择配音文件" }); return; }
  if (!cloneText) { showNotice({ tone: "warning", message: "请填写复刻文本", focusTarget: ttsEl("tts-clone-text") }); return; }
  if (!voiceId) { showNotice({ tone: "warning", message: "请填写音色命名", focusTarget: ttsEl("tts-clone-voice-id") }); return; }
  const voiceIdError = validateMiniMaxVoiceId(voiceId);
  if (voiceIdError) { setCloneStatus("❌ " + voiceIdError, "error"); return; }

  const btn = document.getElementById("tts-clone-start") as HTMLButtonElement;
  btn.disabled = true;
  setCloneStatus("正在上传配音文件…", "loading");

  try {
    // 步骤1: 上传配音文件
    const cloneUpload = await window.tts.upload(apiKey, cloneFile, "voice_clone");
    setCloneStatus("配音文件上传完成 (file_id: " + cloneUpload.file_id + ")，正在上传示例音频…", "loading");

    // 步骤2: 上传示例音频（可选）
    let promptFileId: string | undefined;
    if (promptFile) {
      const promptUpload = await window.tts.upload(apiKey, promptFile, "prompt_audio");
      promptFileId = promptUpload.file_id;
      setCloneStatus("示例音频上传完成，正在训练音色…", "loading");
    } else {
      setCloneStatus("正在训练音色…", "loading");
    }

    // 步骤3: 音色克隆
    const result = await window.tts.clone({
      apiKey, fileId: cloneUpload.file_id, voiceId,
      promptAudioId: promptFileId, promptText: promptText || undefined,
      text: cloneText,
    });

    // 自动填入音色 ID
    ttsEl("tts-minimax-voice").value = result.voiceId;
    void saveTtsField("ttsMinimaxVoiceId", result.voiceId);

    setCloneStatus("✅ 复刻成功！音色 ID「" + result.voiceId + "」已自动填入。", "ok");

    // 如果有试听音频，播放
    if (result.audioDemo) {
      try {
        const resp = await fetch(result.audioDemo);
        const buf = await resp.arrayBuffer();
        const base64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
        playTtsAudio(base64);
      } catch { /* 试听音频播放失败不影响主流程 */ }
    }
  } catch (err) {
    setCloneStatus("❌ " + (err instanceof Error ? err.message : String(err)), "error");
    // 失败可能是"服务端已创建但响应丢失"（重试同 ID 会报 2039 重复），
    // 自动换一个新的音色 ID，让用户直接点重试即可。
    const failedVoiceId = ttsEl("tts-clone-voice-id").value.trim();
    if (failedVoiceId) {
      ttsEl("tts-clone-voice-id").value = createUniqueMiniMaxVoiceId();
    }
  } finally {
    btn.disabled = false;
  }
});

// ── 音色快速复刻：规格说明模态框 ──
// 字段顺序：file_id → voice_id → clone_prompt(prompt_audio / prompt_text) → text(试听)
const CLONE_SPEC_BODY = [
  '<div class="tts-clone-spec-block">',
  '  <h4>',
  '    <svg class="tts-clone-spec-icon" width="18" height="18" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">',
  '      <path d="M24 44C35.0457 44 44 35.0457 44 24C44 12.9543 35.0457 4 24 4C12.9543 4 4 12.9543 4 24C4 35.0457 12.9543 44 24 44Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/>',
  '      <path d="M18 22H30" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>',
  '      <path d="M18 28H30" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>',
  '      <path d="M24.0083 22V34" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>',
  '      <path d="M30 15L24 21L18 15" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>',
  '    </svg>',
  '    费用',
  '  </h4>',
  '  <p>每次成功发起复刻将收取 <span class="tts-clone-fee">¥9.9</span>。',
  '     试听（<code>text</code> + <code>model</code>）按字符数另计 T2A 费用，与平台其他 T2A 接口同价。</p>',
  '</div>',
  '<div class="tts-clone-spec-block">',
  '  <h4>',
  '    <svg class="tts-clone-spec-icon" width="18" height="18" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">',
  '      <path d="M7 4H41" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>',
  '      <path d="M7 44H41" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>',
  '      <path d="M11 44C13.6667 30.6611 18 23.9944 24 24C30 24.0056 34.3333 30.6722 37 44H11Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/>',
  '      <path d="M37 4C34.3333 17.3389 30 24.0056 24 24C18 23.9944 13.6667 17.3278 11 4H37Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/>',
  '      <path d="M21 15H27" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>',
  '      <path d="M19 38H29" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>',
  '    </svg>',
  '    过期规则',
  '  </h4>',
  '  <p>复刻得到的音色若 <strong>7 天内</strong>无任何调用，将被系统自动删除。如需长期保留音色，平时不定期点一下「🔊 测试发音」即可续命。</p>',
  '</div>',
  '<div class="tts-clone-spec-block">',
  '  <h4>',
  '    <svg class="tts-clone-spec-icon" width="18" height="18" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">',
  '      <path d="M8 44V4H31L40 14.5V44H8Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>',
  '      <path d="M32 14L26 16.9688V31.5" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>',
  '      <circle cx="20.5" cy="31.5" r="5.5" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>',
  '    </svg>',
  '    配音文件 <code>file_id</code>（必填）',
  '  </h4>',
  '  <ul>',
  '    <li>格式：mp3 / m4a / wav</li>',
  '    <li>时长：10 秒 ~ 5 分钟</li>',
  '    <li>大小：≤ 20 MB</li>',
  '  </ul>',
  '</div>',
  '<div class="tts-clone-spec-block">',
  '  <h4>',
  '    <svg class="tts-clone-spec-icon" width="18" height="18" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">',
  '      <path d="M10 10H32H38V44H10V10Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>',
  '      <path d="M10 10L32 4V10" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>',
  '      <circle cx="24" cy="24" r="4" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>',
  '      <path d="M20 34H28" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>',
  '    </svg>',
  '    自定义 voice_id（必填）',
  '  </h4>',
  '  <ul>',
  '    <li>长度范围：8 ~ 256 个字符</li>',
  '    <li>首字符必须为英文字母</li>',
  '    <li>允许：数字、字母、<code>-</code>、<code>_</code></li>',
  '    <li>末位字符不可为 <code>-</code> 或 <code>_</code></li>',
  '    <li>不得与已有 voice_id 重复</li>',
  '  </ul>',
  '</div>',
  '<div class="tts-clone-spec-block">',
  '  <h4>',
  '    <svg class="tts-clone-spec-icon" width="18" height="18" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">',
  '      <path d="M24 44C35.0457 44 44 35.0457 44 24C44 12.9543 35.0457 4 24 4C12.9543 4 4 12.9543 4 24C4 35.0457 12.9543 44 24 44Z" fill="none" stroke="currentColor" stroke-width="4"/>',
  '      <path d="M30 18V30" stroke="currentColor" stroke-width="4" stroke-linecap="round"/>',
  '      <path d="M36 22V26" stroke="currentColor" stroke-width="4" stroke-linecap="round"/>',
  '      <path d="M18 18V30" stroke="currentColor" stroke-width="4" stroke-linecap="round"/>',
  '      <path d="M12 22V26" stroke="currentColor" stroke-width="4" stroke-linecap="round"/>',
  '      <path d="M24 14V34" stroke="currentColor" stroke-width="4" stroke-linecap="round"/>',
  '    </svg>',
  '    示例音频 clone_prompt（可选，强烈推荐）',
  '  </h4>',
  '  <p>提供一段示例音频可显著增强合成音色的相似度与稳定性。</p>',
  '  <ul>',
  '    <li>格式：mp3 / m4a / wav</li>',
  '    <li>时长：&lt; 8 秒</li>',
  '    <li>大小：≤ 20 MB</li>',
  '    <li>须填写对应的示例文本 <code>prompt_text</code>，句末需有标点</li>',
  '  </ul>',
  '</div>',
  '<div class="tts-clone-spec-block">',
  '  <h4>',
  '    <svg class="tts-clone-spec-icon" width="18" height="18" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">',
  '      <path d="M40 33V42C40 43.1046 39.1046 44 38 44H31.5" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>',
  '      <path d="M40 16V6C40 4.89543 39.1046 4 38 4H10C8.89543 4 8 4.89543 8 6V42C8 43.1046 8.89543 44 10 44H16" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>',
  '      <path d="M16 16H30" stroke="currentColor" stroke-width="4" stroke-linecap="round"/>',
  '      <path d="M23 44L40 23" stroke="currentColor" stroke-width="4" stroke-linecap="round"/>',
  '      <path d="M16 24H24" stroke="currentColor" stroke-width="4" stroke-linecap="round"/>',
  '    </svg>',
  '    复刻文本 <code>text</code>（试听用，建议 ≤1000 字符）',
  '  </h4>',
  '  <p>模型会用克隆后的音色朗读这段文本并返回试听音频链接，便于人工核对相似度。</p>',
  '</div>',
].join("\n");

function showCloneSpecModal(): void {
  void showHtmlModal({
    title: "🎙️ 音色快速复刻 · 完整规格",
    icon: "ⓘ",
    htmlBody: CLONE_SPEC_BODY,
  });
}

document.getElementById("tts-clone-info-btn")?.addEventListener("click", showCloneSpecModal);
document.getElementById("tts-clone-info-link")?.addEventListener("click", showCloneSpecModal);

const cloneVoiceIdInput = document.getElementById("tts-clone-voice-id") as HTMLInputElement | null;
if (cloneVoiceIdInput && !cloneVoiceIdInput.value.trim()) {
  cloneVoiceIdInput.value = createUniqueMiniMaxVoiceId();
}

// 初始加载配置
void loadTtsConfig();
