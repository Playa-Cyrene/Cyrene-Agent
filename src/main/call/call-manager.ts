// 通话轮次协调器 —— 编排 ASR → agent → TTS 的轮次循环。
//
// 状态机：
//   IDLE → LISTENING → (VAD 静默) → THINKING → (agent+TTS) → SPEAKING → (播完) → LISTENING
//
// 配置通过 setCallSettings 注入 getter（避免 import index.ts 循环依赖）。

import { BrowserWindow } from "electron";
import { IPC } from "../../shared/ipc-channels";
import { createIpcScope, type IpcScope } from "../application/ipc-scope";
import { getAsrConfig, type AsrConfig } from "../asr/asr-config";
import { createAsrStream, type AsrStreamSession } from "../asr/asr-dispatcher";
import { synthesizeByEngine } from "../tts/tts-dispatcher";
import type { TtsEngine } from "../../shared/tts-types";
import { createLlmClient, type LlmRequestSettings } from "../services/llm/llm-client";
import { resolveTimeoutPolicy } from "../runtime-policy";
import { resolveTransport } from "../orchestrator/vendors";

const LOG_PREFIX = "[CallManager]";

export type CallState = "IDLE" | "LISTENING" | "THINKING" | "SPEAKING" | "ERROR" | "ENDED";

let callWindow: BrowserWindow | null = null;
let asrStream: AsrStreamSession | null = null;
let currentState: CallState = "IDLE";
let finalText = "";
let latestPartialText = "";
let active = false;
let activeTurnController: AbortController | null = null;
const callLlmClient = createLlmClient();

/** 通话输入所有者：builtin 为内置 ASR，external 为插件语音租约接管。 */
type CallInputOwner = "builtin" | "external";
let inputOwner: CallInputOwner = "builtin";
/** 通话代次：每次 startCall 单调递增；外部租约冻结该值，防止提交到下一次通话。 */
let callGeneration = 0;
/** 通话结束监听器：语音租约服务据此立即中止 active-call 租约。 */
const callEndedListeners = new Set<(generation: number) => void>();

/** 通话结束通知（挂断或通话窗口关闭触发）；generation 为刚结束通话的代次。 */
export function onCallEnded(listener: (generation: number) => void): () => void {
  callEndedListeners.add(listener);
  return () => {
    callEndedListeners.delete(listener);
  };
}

function notifyCallEnded(generation: number): void {
  for (const listener of [...callEndedListeners]) {
    try {
      listener(generation);
    } catch (error) {
      console.warn(LOG_PREFIX, "通话结束监听器抛错", error);
    }
  }
}

/** 通话上下文：保留最近 N 轮对话历史（每轮 = user + assistant 一对）。
 * 主聊天窗口（src/main/index.ts:1276 normalizeChatMessages）默认保留 24 条（12 轮）。
 * 通话场景对短上下文敏感度低，但用户希望"加点内存"——给到 24 轮（48 条），
 * 短上下文模型如果爆了由 settings 里的 model context_length 兜底。 */
const MAX_CALL_CONTEXT_TURNS = 24;
const callHistory: Array<{ role: "user" | "assistant"; content: string }> = [];

/** 滑动窗口截断：每次 push 两轮后调用，保留最近 MAX_CALL_CONTEXT_TURNS 轮。
 * 这样 callHistory 数组本身有界（48 条），不会被长通话撑爆内存。 */
function trimCallHistory(): void {
  if (callHistory.length > MAX_CALL_CONTEXT_TURNS * 2) {
    callHistory.splice(0, callHistory.length - MAX_CALL_CONTEXT_TURNS * 2);
  }
}

// 注入的配置 getter（由 index.ts 启动时设置，避免循环依赖）
let modelSettingsGetter: (() => LlmRequestSettings) | null = null;
let ttsSettingsGetter: (() => {
  ttsEngine: TtsEngine;
  ttsMinimaxKey: string; ttsMinimaxVoiceId: string;
  ttsMinimaxModel: "speech-2.8-hd" | "speech-2.8-turbo";
  ttsSpeed: number; ttsVolume: number;
  // MiniMax
  ttsMinimaxVocalEnhance: boolean;
  ttsGptsovitsBaseUrl: string; ttsGptsovitsRefAudioPath: string;
  ttsGptsovitsPromptText: string; ttsGptsovitsFormat: "wav" | "mp3";
  ttsGptsovitsTimeoutMs: number;
  ttsCustomCloudEndpointUrl: string; ttsCustomCloudApiKey: string; ttsCustomCloudVoiceId: string;
  ttsCustomCloudFormat: "wav" | "mp3"; ttsCustomCloudTimeoutMs: number;
  ttsMimoKey: string; ttsMimoVoiceAudioPath: string; ttsMimoStylePrompt: string;
}) | null = null;

/** index.ts 启动时注入模型配置、TTS 配置和 system prompt 构建器。 */
let systemPromptBuilder: ((userText: string) => Promise<string>) | null = null;
let weatherHandler: ((userText: string) => Promise<string | null>) | null = null;

export function setCallSettings(
  modelGetter: () => LlmRequestSettings,
  ttsGetter: () => {
    ttsEngine: TtsEngine;
    ttsMinimaxKey: string; ttsMinimaxVoiceId: string;
    ttsMinimaxModel: "speech-2.8-hd" | "speech-2.8-turbo";
    ttsSpeed: number; ttsVolume: number;
    ttsMinimaxVocalEnhance: boolean;
    ttsGptsovitsBaseUrl: string; ttsGptsovitsRefAudioPath: string;
    ttsGptsovitsPromptText: string; ttsGptsovitsFormat: "wav" | "mp3";
    ttsGptsovitsTimeoutMs: number;
    ttsCustomCloudEndpointUrl: string; ttsCustomCloudApiKey: string; ttsCustomCloudVoiceId: string;
    ttsCustomCloudFormat: "wav" | "mp3"; ttsCustomCloudTimeoutMs: number;
    ttsMimoKey: string; ttsMimoVoiceAudioPath: string; ttsMimoStylePrompt: string;
  },
  systemPromptFn: (userText: string) => Promise<string>,
  weatherFn: (userText: string) => Promise<string | null>,
): void {
  modelSettingsGetter = modelGetter;
  ttsSettingsGetter = ttsGetter;
  systemPromptBuilder = systemPromptFn;
  weatherHandler = weatherFn;
}

/** 绑定通话窗口（createCallWindow 调一次）。 */
export function setCallWindow(win: BrowserWindow | null): void {
  callWindow = win;
}

/** 是否正在通话中。 */
export function isCallActive(): boolean {
  return active;
}

function sendState(state: CallState): void {
  currentState = state;
  if (callWindow && !callWindow.isDestroyed()) {
    callWindow.webContents.send(IPC.CALL_STATE, { state });
  }
  console.log(LOG_PREFIX, "状态 →", state);
}

function sendError(message: string): void {
  if (callWindow && !callWindow.isDestroyed()) {
    callWindow.webContents.send(IPC.CALL_ERROR, { message });
  }
  console.error(LOG_PREFIX, "错误:", message);
}

function getNetworkCauseDetails(error: unknown): { code?: string; syscall?: string; port?: number } {
  let current: unknown = error;
  let deepest: { code?: string; syscall?: string; port?: number } = {};
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth++) {
    const candidate = current as { cause?: unknown; code?: unknown; syscall?: unknown; port?: unknown };
    const details = {
      code: typeof candidate.code === "string" ? candidate.code : undefined,
      syscall: typeof candidate.syscall === "string" ? candidate.syscall : undefined,
      port: typeof candidate.port === "number" ? candidate.port : undefined,
    };
    if (details.code || details.syscall || details.port) deepest = details;
    current = candidate.cause;
  }
  return deepest;
}

function getConfiguredHost(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname || "(empty host)";
  } catch {
    return "(invalid base URL)";
  }
}

function isCurrentCall(generation: number): boolean {
  return active && generation === callGeneration;
}

function sendAsrResult(partial: string | undefined, final: string | undefined): void {
  if (callWindow && !callWindow.isDestroyed()) {
    callWindow.webContents.send(IPC.CALL_ASR_RESULT, { partial, final });
  }
}

function sendTtsAudio(base64: string, text: string): void {
  if (callWindow && !callWindow.isDestroyed()) {
    callWindow.webContents.send(IPC.CALL_TTS_AUDIO, { base64, text });
  }
}

/** 开始通话：初始化 ASR 流，进入 LISTENING。 */
export function startCall(): void {
  if (active) return;
  const cfg = getAsrConfig();
  const missingConfig = !cfg
    || (cfg.engine === "aliyun" && (!cfg.appKey || !cfg.accessKeyId || !cfg.accessKeySecret))
    || (cfg.engine === "mossland" && !cfg.apiKey);
  if (missingConfig) {
    sendError("ASR 未配置：请在设置→ASR 中选择服务商并填写凭据");
    sendState("ERROR");
    return;
  }

  active = true;
  callGeneration += 1;
  inputOwner = "builtin";
  finalText = "";
  latestPartialText = "";
  callHistory.length = 0;
  console.log(LOG_PREFIX, "startCall 重置: finalText 清空, history 清空");
  startAsrStream(cfg, callGeneration);
  sendState("LISTENING");
}

/** 创建并启动一个 ASR 流。 */
function startAsrStream(cfg: AsrConfig, generation = callGeneration): void {
  asrStream = createAsrStream(
    cfg,
    (text) => { latestPartialText = text; sendAsrResult(text, undefined); },
    (text) => { finalText = text; latestPartialText = text; sendAsrResult(undefined, text); },
  );
  void asrStream.start().catch((err) => {
    if (!isCurrentCall(generation)) return;
    const message = err instanceof Error ? err.message : String(err);
    sendError(`ASR 启动失败：${message}`);
    sendState("ERROR");
  });
}

/**
 * 停止内置 ASR 并收集最终转写文本。
 * 返回空字符串表示无有效文本；停止失败返回 null（调用方恢复 LISTENING）。
 */
async function stopAsrAndCollectText(generation: number): Promise<string | null> {
  if (asrStream) {
    const stream = asrStream;
    asrStream = null;
    try {
      await stream.stop();
    } catch (err) {
      if (!isCurrentCall(generation)) return null;
      const message = err instanceof Error ? err.message : String(err);
      sendError(message);
      return null;
    }
  }
  if (!isCurrentCall(generation)) return null;
  const text = finalText.trim() || latestPartialText.trim();
  finalText = "";
  latestPartialText = "";
  return text;
}

/** 校验最终转写：去掉首尾空白后非空才进入模型轮次。 */
function validateFinalTranscript(text: string): string | null {
  const trimmed = text.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** 轮次失败或空文本后的兜底恢复：回 LISTENING，输入所有者决定是否重启内置 ASR。 */
function recoverToListening(generation: number): void {
  if (!isCurrentCall(generation)) return;
  sendState("LISTENING");
  restartAsr();
}

/**
 * 处理最终转写文本：Agent → TTS → SPEAKING。
 * 内置 ASR 与外部插件语音共用同一条流水线；播完后由 onTtsDone 回 LISTENING。
 */
async function processFinalTranscript(text: string, generation: number): Promise<void> {
  const controller = new AbortController();
  activeTurnController?.abort();
  activeTurnController = controller;
  try {
    // 调 agent 获取回复
    console.log(LOG_PREFIX, "runAgentTurn 开始, text.length=", text.length);
    const reply = await runAgentTurn(text, controller.signal, generation);
    if (!isCurrentCall(generation) || controller.signal.aborted) return;
    console.log(LOG_PREFIX, "runAgentTurn 结果: reply.length=", reply?.length ?? "null");
    if (!reply) {
      sendError("未收到 agent 回复");
      recoverToListening(generation);
      return;
    }

    // TTS 合成（按 ttsEngine 分发到对应引擎）
    const tts = ttsSettingsGetter?.();
    if (!tts || tts.ttsEngine === "off") {
      sendError("TTS 未配置：请在设置中启用 TTS 引擎");
      recoverToListening(generation);
      return;
    }

    // 引擎配置完整性检查
    if (tts.ttsEngine === "minimax" && (!tts.ttsMinimaxKey || !tts.ttsMinimaxVoiceId)) {
      sendError("TTS 未配置：请在设置中配置 MiniMax API Key 和音色 ID");
      recoverToListening(generation);
      return;
    }
    if (tts.ttsEngine === "gptsovits" && (!tts.ttsGptsovitsBaseUrl || !tts.ttsGptsovitsRefAudioPath || !tts.ttsGptsovitsPromptText)) {
      sendError("TTS 未配置：请在设置中配置 GPT-SoVITS baseUrl、参考音频和文本");
      recoverToListening(generation);
      return;
    }
    if (tts.ttsEngine === "custom-cloud" && !tts.ttsCustomCloudEndpointUrl) {
      sendError("TTS 未配置：请在设置中配置自定义云端 Endpoint URL");
      recoverToListening(generation);
      return;
    }
    if (tts.ttsEngine === "mimo" && (!tts.ttsMimoKey || !tts.ttsMimoVoiceAudioPath)) {
      sendError("TTS 未配置：请在设置中配置小米 MiMo API Key 和昔涟克隆音频");
      recoverToListening(generation);
      return;
    }

    if (!isCurrentCall(generation) || controller.signal.aborted) return;
    sendState("SPEAKING");
    try {
      const result = await synthesizeByEngine(tts.ttsEngine, {
        text: reply,
        speed: tts.ttsSpeed,
        volume: tts.ttsVolume,
        // minimax
        apiKey: tts.ttsEngine === "mimo"
          ? tts.ttsMimoKey
          : tts.ttsEngine === "custom-cloud"
            ? tts.ttsCustomCloudApiKey
            : tts.ttsMinimaxKey,
        voiceId: tts.ttsEngine === "mimo"
          ? ""
          : tts.ttsEngine === "custom-cloud"
            ? tts.ttsCustomCloudVoiceId
            : tts.ttsMinimaxVoiceId,
        model: tts.ttsMinimaxModel,
        // gptsovits
        baseUrl: tts.ttsGptsovitsBaseUrl,
        refAudioPath: tts.ttsGptsovitsRefAudioPath,
        promptText: tts.ttsGptsovitsPromptText,
        format: tts.ttsGptsovitsFormat,
        // custom-cloud
        endpointUrl: tts.ttsCustomCloudEndpointUrl,
        timeoutMs: tts.ttsEngine === "gptsovits" ? tts.ttsGptsovitsTimeoutMs : tts.ttsCustomCloudTimeoutMs,
        vocalEnhance: tts.ttsEngine === "minimax" ? { enabled: tts.ttsMinimaxVocalEnhance } : undefined,
        voiceAudioPath: tts.ttsMimoVoiceAudioPath,
        stylePrompt: tts.ttsMimoStylePrompt,
        ...(tts.ttsEngine === "custom-cloud" ? { format: tts.ttsCustomCloudFormat } : {}),
      });
      if (!isCurrentCall(generation) || controller.signal.aborted) return;
      sendTtsAudio(result.audio.toString("base64"), reply);
      // 等渲染端 CALL_TTS_DONE 后恢复 LISTENING
    } catch (ttsErr) {
      if (!isCurrentCall(generation) || controller.signal.aborted) return;
      const msg = ttsErr instanceof Error ? ttsErr.message : String(ttsErr);
      sendError("TTS 合成失败：" + msg);
      recoverToListening(generation);
    }
  } catch (err) {
    if (!isCurrentCall(generation) || controller.signal.aborted) return;
    const msg = err instanceof Error ? err.message : String(err);
    sendError("通话出错：" + msg);
    recoverToListening(generation);
  } finally {
    if (activeTurnController === controller) activeTurnController = null;
  }
}

/** 结束本轮（VAD 静默）：停 ASR → 校验文本 → Agent → TTS → 播放。 */
export async function endTurn(): Promise<void> {
  console.log(LOG_PREFIX, "endTurn 入口: active=", active, "state=", currentState, "finalText.length=", finalText.length);
  if (!active || currentState !== "LISTENING") return;
  const generation = callGeneration;
  // 外部插件持有输入期间，忽略内置 VAD 的静默结束信号
  if (inputOwner === "external") return;

  // 立即离开 LISTENING，避免批量转写等待期间被手动按钮或 VAD 重复提交。
  sendState("THINKING");

  const text = await stopAsrAndCollectText(generation);
  if (!isCurrentCall(generation)) return;
  if (text === null) {
    recoverToListening(generation);
    return;
  }

  const finalTranscript = validateFinalTranscript(text);
  if (!finalTranscript) {
    // 空文本，直接重启 ASR 回 LISTENING
    console.log(LOG_PREFIX, "endTurn 空文本，直接重启 ASR");
    recoverToListening(generation);
    return;
  }

  await processFinalTranscript(finalTranscript, generation);
}

/** 外部语音租约接管通话输入的结果。 */
export type ExternalInputClaimResult = { callGeneration: number } | null;

/** 外部语音租约接管通话输入：无活动通话返回 null，成功则停止内置 ASR 并冻结通话代次。 */
export function claimExternalSpeechInput(): ExternalInputClaimResult {
  if (!active) return null;
  inputOwner = "external";
  // 音频帧已被 inputOwner 门挡住；停止失败仅告警，不影响接管成立
  if (asrStream) {
    const stream = asrStream;
    asrStream = null;
    void Promise.resolve(stream.stop()).catch((err) => {
      console.warn(LOG_PREFIX, "外部接管时停止内置 ASR 失败:", err);
    });
  }
  // 内置转写的残留文本随接管作废，避免恢复内置 ASR 后串轮
  finalText = "";
  latestPartialText = "";
  return { callGeneration };
}

/** 外部文本提交结果；reason 供宿主映射为稳定错误码。 */
export type ExternalTextSubmitResult =
  | { ok: true }
  | { ok: false; reason: "no-call" | "stale-call" | "busy" | "not-owner" | "empty-text" };

/**
 * 外部文本提交入口：校验通过（通话仍在、代次匹配、外部持有、LISTENING 状态）后
 * 走与内置转写相同的 Agent → TTS 流水线，接受即返回，不等待轮次结束。
 */
export function submitExternalText(callGenerationFrozen: number, text: string): ExternalTextSubmitResult {
  if (!active) return { ok: false, reason: "no-call" };
  if (callGenerationFrozen !== callGeneration) return { ok: false, reason: "stale-call" };
  if (inputOwner !== "external") return { ok: false, reason: "not-owner" };
  if (currentState !== "LISTENING") return { ok: false, reason: "busy" };
  // 宿主侧已校验非空，这里兜底拒绝空白文本
  const finalTranscript = validateFinalTranscript(text);
  if (!finalTranscript) return { ok: false, reason: "empty-text" };
  sendState("THINKING");
  void processFinalTranscript(finalTranscript, callGenerationFrozen);
  return { ok: true };
}

/**
 * 释放外部输入所有权：同一通话仍有效时归还内置 ASR。
 * THINKING/SPEAKING 期间释放则不抢启，等轮次结束的恢复路径自然重启。
 */
export function releaseExternalSpeechInput(callGenerationFrozen: number): void {
  if (!active || callGenerationFrozen !== callGeneration || inputOwner !== "external") return;
  inputOwner = "builtin";
  if (currentState === "LISTENING") {
    restartAsr();
  }
}

/** TTS 播完后恢复 LISTENING，重新开始 ASR。 */
export function onTtsDone(): void {
  if (!active) return;
  sendState("LISTENING");
  // 外部输入持有时保持所有权：不自动重启内置 ASR，等租约释放时恢复
  restartAsr();
}

/** 重新开始一轮 ASR 识别；外部输入持有期间不启动内置 ASR。 */
function restartAsr(): void {
  if (inputOwner !== "builtin") return;
  const cfg = getAsrConfig();
  if (!cfg) return;
  if (asrStream) void Promise.resolve(asrStream.stop()).catch((err) => {
    console.warn(LOG_PREFIX, "停止上一轮 ASR 失败:", err);
  });
  finalText = "";
  latestPartialText = "";
  startAsrStream(cfg, callGeneration);
}

/** 挂断：清理一切。 */
export function stopCall(): void {
  // 先收尾本地状态再广播：监听方收到通知时通话已不可提交，释放路径自然 no-op
  const endedGeneration = callGeneration;
  active = false;
  activeTurnController?.abort();
  activeTurnController = null;
  inputOwner = "builtin";
  finalText = "";
  latestPartialText = "";
  callHistory.length = 0;
  if (asrStream) {
    void Promise.resolve(asrStream.stop()).catch((err) => {
      console.warn(LOG_PREFIX, "挂断时停止 ASR 失败:", err);
    });
    asrStream = null;
  }
  sendState("ENDED");
  notifyCallEnded(endedGeneration);
}

/** 处理音频帧：转发给 ASR；外部输入持有期间忽略通话音频，防止双输入源。 */
export function handleAudioFrame(frame: Buffer): void {
  if (inputOwner === "external") return;
  if (asrStream && currentState === "LISTENING") {
    asrStream.sendAudio(frame);
  }
}

/** 天气关键词正则匹配 */
const WEATHER_REGEX = /天气|今天.*热|今天.*冷|下雨|下雪|气温|几度|多少度|穿什么/;

/**
 * 获取回复文本。
 * 1. 先正则匹配天气 → 直接查天气
 * 2. 否则直接调 LLM（不走 FC loop，不调工具），用通话专用 system prompt
 * 3. 回复过滤掉 [sticker:xxx] 表情包标记
 */
async function runAgentTurn(userText: string, signal: AbortSignal, generation: number): Promise<string | null> {
  let stage = "天气查询";
  let requestSettings: LlmRequestSettings | null = null;
  try {
    // 1. 天气正则匹配
    if (WEATHER_REGEX.test(userText) && weatherHandler) {
      const weatherReply = await weatherHandler(userText);
      if (!isCurrentCall(generation) || signal.aborted) return null;
      if (weatherReply) {
        // 天气走快捷路径，也记入上下文
        callHistory.push({ role: "user", content: userText });
        callHistory.push({ role: "assistant", content: weatherReply });
        trimCallHistory();
        return weatherReply;
      }
    }

    // 2. 直接调 LLM（不走 FC loop）
    stage = "模型配置读取";
    requestSettings = modelSettingsGetter?.() ?? null;
    if (!requestSettings || !requestSettings.apiKey) {
      throw new Error("模型配置缺失或未填写 API Key");
    }

    stage = "通话提示词构建";
    const systemPrompt = await systemPromptBuilder?.(userText) ?? "";
    if (!isCurrentCall(generation) || signal.aborted) return null;
    const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
      { role: "system", content: systemPrompt },
      // 取最近 MAX_CALL_CONTEXT_TURNS 轮历史（每轮 2 条：user + assistant）
      ...callHistory.slice(-MAX_CALL_CONTEXT_TURNS * 2),
      { role: "user", content: userText },
    ];

    stage = "模型请求";
    // Kimi k2.6 只允许特定 temperature，省略让服务端使用默认值。
    const callTemperature = requestSettings.model.match(/^kimi-k2\.6(?:$|-)/i) ? undefined : 0.8;
    const resp = await callLlmClient.chatNonStream(
      requestSettings,
      messages,
      callTemperature,
      resolveTimeoutPolicy({ stage: "call-management" }).totalMs,
      "call-management",
      undefined,
      undefined,
      signal,
    );
    if (!isCurrentCall(generation) || signal.aborted) return null;
    // 过滤掉表情包标记
    const reply = (resp.text || "").replace(/\[sticker:[^\]]+\]/g, "").trim();

    // 记入通话上下文
    if (reply) {
      callHistory.push({ role: "user", content: userText });
      callHistory.push({ role: "assistant", content: reply });
      trimCallHistory();
    }

    return reply || null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!isCurrentCall(generation) || signal.aborted) throw err;
    const transport = requestSettings
      ? resolveTransport(requestSettings)
      : undefined;
    console.error(LOG_PREFIX, "通话轮次失败", {
      stage,
      generation,
      provider: requestSettings?.provider,
      model: requestSettings?.model,
      host: requestSettings ? getConfiguredHost(requestSettings.baseUrl) : undefined,
      transport,
      error: msg,
      cause: getNetworkCauseDetails(err),
    });
    throw new Error(`${stage}失败：${msg}`);
  }
}

/** 注册通话 IPC handlers（core bootstrap 启动时调一次）。 */
export function registerCallIpc(ipcOption?: IpcScope): void {
  const ipc = ipcOption ?? createIpcScope();
  ipc.on(IPC.CALL_START, () => startCall());
  ipc.on(IPC.CALL_AUDIO_FRAME, (_event, frame: ArrayBuffer) => handleAudioFrame(Buffer.from(frame)));
  ipc.on(IPC.CALL_TURN_END, () => void endTurn());
  ipc.on(IPC.CALL_TTS_DONE, () => onTtsDone());
  ipc.on(IPC.CALL_STOP, () => stopCall());
}
