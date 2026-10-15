import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { loadGeneralSettings } from "../../settings/settings-facade";
import type { GeneralSettings } from "../../settings/general-settings";
import * as chatsStore from "../../chats/chats-store";
import type {
  StartTtsRequest,
  TtsAudioFormat,
  TtsSessionEvent,
  TtsStartResult,
} from "../../../shared/tts-session";
import { synthesize as minimaxSynthesize } from "../../tts/minimax-engine";
import { synthesize as gptsovitsSynthesize } from "../../tts/gptsovits-engine";
import { synthesize as customCloudSynthesize } from "../../tts/custom-cloud-engine";
import { synthesize as mimoSynthesize } from "../../tts/mimo-engine";
import { synthesize as mosslandSynthesize } from "../../tts/mossland-engine";
import { synthesizeByEngine } from "../../tts/tts-dispatcher";
import { runTtsStreamingWithFallback } from "../../tts/tts-streaming-fallback";
import { versionTtsCacheKey } from "../../tts/tts-cache-key";
import {
  appendMinimaxTtsLog,
  appendGptsovitsTtsLog,
  appendCustomCloudTtsLog,
  appendMimoTtsLog,
  buildTtsCacheKey,
  buildGptsovitsCacheKey,
  buildCustomCloudCacheKey,
  buildMimoCacheKey,
  buildMosslandCacheKey,
  getTtsCachePath,
  readTtsCacheByKey,
} from "../../tts/tts-cache";
import type { TtsSessionExecution } from "../../tts/tts-session-service";
import { transcodeAudioFileToFeishuOpus } from "../../channels/adapters/feishu/audio-transcode";
import type { ChannelId } from "../../channels/types";

type ChannelTtsAudioFormat = TtsAudioFormat | "opus";

export interface TtsSynthesisServiceDeps {
  convertFeishuAudio?: (audio: Buffer, sourceFormat: TtsAudioFormat) => Promise<Buffer>;
}

export interface TtsSynthesisService {
  synthesizeSession(
    request: StartTtsRequest,
    signal: AbortSignal,
    emit: (event: TtsSessionEvent) => void,
  ): Promise<TtsStartResult | TtsSessionExecution>;

  synthesizeChannelTts(
    text: string,
    cfg: GeneralSettings,
    channel: ChannelId,
  ): Promise<{
    audio: Buffer;
    format: ChannelTtsAudioFormat;
    mime: string;
    extension: ".mp3" | ".wav" | ".pcm" | ".opus";
  } | null>;
}

async function convertFeishuAudioWithMpv(
  audio: Buffer,
  sourceFormat: TtsAudioFormat,
): Promise<Buffer> {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "cyrene-feishu-tts-"));
  try {
    const inputPath = path.join(tempDir, `source.${sourceFormat}`);
    await fs.promises.writeFile(inputPath, audio);
    const outputPath = await transcodeAudioFileToFeishuOpus(inputPath);
    return await fs.promises.readFile(outputPath);
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

export function createTtsSynthesisService(
  deps: TtsSynthesisServiceDeps = {},
): TtsSynthesisService {
  async function synthesizeSession(
    request: StartTtsRequest,
    signal: AbortSignal,
    emit: (event: TtsSessionEvent) => void,
  ): Promise<TtsStartResult | TtsSessionExecution> {
    const settings = loadGeneralSettings();
    if (request.automatic && !settings.ttsAutoRead) {
      return { requestId: request.requestId, status: "skipped" };
    }

    const historicalMessage = (await chatsStore
      .getSession(request.conversationId))
      ?.messages.find(
        (message) => message.id === request.messageId && message.role === "model",
      );
    if (
      historicalMessage?.ttsCacheKey &&
      historicalMessage.ttsCacheVersion === request.converterVersion
    ) {
      const cached = readTtsCacheByKey(historicalMessage.ttsCacheKey);
      if (cached) {
        return {
          requestId: request.requestId,
          status: "ready",
          base64: cached.audio.toString("base64"),
          cacheKey: historicalMessage.ttsCacheKey,
          format: cached.format,
          cached: true,
        };
      }
    }

    if (settings.ttsEngine === "off") {
      if (request.automatic) {
        return { requestId: request.requestId, status: "skipped" };
      }
      throw new Error("请先在设置中启用 TTS 引擎");
    }
    if (signal.aborted) {
      return { requestId: request.requestId, status: "cancelled" };
    }

    let audio: Buffer;
    let format: TtsAudioFormat;
    let cacheKey: string;

    if (settings.ttsEngine === "minimax") {
      if (!settings.ttsMinimaxKey || !settings.ttsMinimaxVoiceId) {
        throw new Error("MiniMax TTS 配置不完整");
      }
      format = "mp3";
      const payload = {
        apiKey: settings.ttsMinimaxKey,
        voiceId: settings.ttsMinimaxVoiceId,
        text: request.speechText,
        speed: settings.ttsSpeed,
        volume: settings.ttsVolume,
        model: settings.ttsMinimaxModel,
        format,
        vocalEnhance: { enabled: settings.ttsMinimaxVocalEnhance },
      };
      cacheKey = buildTtsCacheKey(payload);
      if (settings.ttsStreaming) {
        cacheKey = versionTtsCacheKey(cacheKey, request.converterVersion);
        const cachePath = getTtsCachePath(cacheKey, format);
        const persist = (buffer: Buffer) => {
          fs.mkdirSync(path.dirname(cachePath), { recursive: true });
          fs.writeFileSync(cachePath, buffer);
          appendMinimaxTtsLog({
            requestId: request.requestId,
            ts: new Date().toISOString(),
            phase: "session.stream.cache.write",
            cacheKey,
            audioBytes: buffer.length,
          });
        };
        const completion = runTtsStreamingWithFallback({
          requestId: request.requestId,
          cacheKey,
          format,
          signal,
          stream: (onChunk) =>
            minimaxSynthesize({
              ...payload,
              signal,
              onChunk,
              debugLog: appendMinimaxTtsLog,
            }),
          fallback: () =>
            minimaxSynthesize({
              ...payload,
              signal,
              debugLog: appendMinimaxTtsLog,
            }),
          persist,
          emit,
        });
        return {
          result: { requestId: request.requestId, status: "streaming", cacheKey, format },
          completion,
        };
      }
      audio = await minimaxSynthesize({
        ...payload,
        signal,
        debugLog: appendMinimaxTtsLog,
      });
    } else if (settings.ttsEngine === "gptsovits") {
      if (
        !settings.ttsGptsovitsBaseUrl ||
        !settings.ttsGptsovitsRefAudioPath ||
        !settings.ttsGptsovitsPromptText
      ) {
        throw new Error("GPT-SoVITS TTS 配置不完整");
      }
      format = settings.ttsGptsovitsFormat;
      const payload = {
        baseUrl: settings.ttsGptsovitsBaseUrl,
        refAudioPath: settings.ttsGptsovitsRefAudioPath,
        promptText: settings.ttsGptsovitsPromptText,
        text: request.speechText,
        speed: settings.ttsSpeed,
        format,
        timeoutMs: settings.ttsGptsovitsTimeoutMs,
      };
      cacheKey = buildGptsovitsCacheKey(payload);
      audio = (
        await gptsovitsSynthesize({ ...payload, debugLog: appendGptsovitsTtsLog })
      ).audio;
    } else if (settings.ttsEngine === "custom-cloud") {
      if (!settings.ttsCustomCloudEndpointUrl) {
        throw new Error("自定义云端 TTS 配置不完整");
      }
      format = settings.ttsCustomCloudFormat;
      const payload = {
        endpointUrl: settings.ttsCustomCloudEndpointUrl,
        apiKey: settings.ttsCustomCloudApiKey,
        voiceId: settings.ttsCustomCloudVoiceId,
        text: request.speechText,
        speed: settings.ttsSpeed,
        volume: settings.ttsVolume,
        format,
        timeoutMs: settings.ttsCustomCloudTimeoutMs,
      };
      cacheKey = buildCustomCloudCacheKey(payload);
      audio = (
        await customCloudSynthesize({ ...payload, debugLog: appendCustomCloudTtsLog })
      ).audio;
    } else if (settings.ttsEngine === "mimo") {
      if (!settings.ttsMimoKey || !settings.ttsMimoVoiceAudioPath) {
        throw new Error("MiMo TTS 配置不完整");
      }
      format = "wav";
      const payload = {
        apiKey: settings.ttsMimoKey,
        voiceAudioPath: settings.ttsMimoVoiceAudioPath,
        text: request.speechText,
        stylePrompt: settings.ttsMimoStylePrompt,
      };
      cacheKey = buildMimoCacheKey(payload);
      audio = (await mimoSynthesize({ ...payload, debugLog: appendMimoTtsLog })).audio;
    } else {
      if (!settings.ttsMosslandKey || !settings.ttsMosslandVoiceId) {
        throw new Error("Mossland TTS 配置不完整");
      }
      format = "mp3";
      const payload = {
        apiKey: settings.ttsMosslandKey,
        voiceId: settings.ttsMosslandVoiceId,
        text: request.speechText,
        model: settings.ttsMosslandModel,
        format,
      };
      cacheKey = buildMosslandCacheKey(payload);
      audio = (await mosslandSynthesize(payload)).audio;
    }

    cacheKey = versionTtsCacheKey(cacheKey, request.converterVersion);
    const cachePath = getTtsCachePath(cacheKey, format);
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, audio);
    return {
      requestId: request.requestId,
      status: "ready",
      base64: audio.toString("base64"),
      cacheKey,
      format,
      cached: false,
    };
  }

  async function synthesizeChannelTts(
    text: string,
    cfg: GeneralSettings,
    channel: ChannelId,
  ): Promise<{
    audio: Buffer;
    format: ChannelTtsAudioFormat;
    mime: string;
    extension: ".mp3" | ".wav" | ".pcm" | ".opus";
  } | null> {
    if (cfg.ttsEngine === "off") return null;
    if (cfg.ttsEngine === "minimax" && (!cfg.ttsMinimaxKey || !cfg.ttsMinimaxVoiceId)) {
      return null;
    }
    if (
      cfg.ttsEngine === "gptsovits" &&
      (!cfg.ttsGptsovitsBaseUrl || !cfg.ttsGptsovitsRefAudioPath || !cfg.ttsGptsovitsPromptText)
    ) {
      return null;
    }
    if (cfg.ttsEngine === "custom-cloud" && !cfg.ttsCustomCloudEndpointUrl) {
      return null;
    }
    if (cfg.ttsEngine === "mimo" && (!cfg.ttsMimoKey || !cfg.ttsMimoVoiceAudioPath)) {
      return null;
    }
    if (cfg.ttsEngine === "mossland" && (!cfg.ttsMosslandKey || !cfg.ttsMosslandVoiceId)) {
      return null;
    }

    const ttsText = text.length > 1000 ? text.slice(0, 1000) + "…" : text;
    try {
      const requestedFormat = channel === "wechat" ? "wav" : "mp3";
      const result = await synthesizeByEngine(cfg.ttsEngine, {
        text: ttsText,
        speed: cfg.ttsSpeed,
        volume: cfg.ttsVolume,
        apiKey:
          cfg.ttsEngine === "mimo"
            ? cfg.ttsMimoKey
            : cfg.ttsEngine === "mossland"
              ? cfg.ttsMosslandKey
            : cfg.ttsEngine === "custom-cloud"
              ? cfg.ttsCustomCloudApiKey
              : cfg.ttsMinimaxKey,
        voiceId:
          cfg.ttsEngine === "mimo"
            ? ""
            : cfg.ttsEngine === "mossland"
              ? cfg.ttsMosslandVoiceId
            : cfg.ttsEngine === "custom-cloud"
              ? cfg.ttsCustomCloudVoiceId
              : cfg.ttsMinimaxVoiceId,
        model: cfg.ttsEngine === "mossland" ? cfg.ttsMosslandModel : cfg.ttsMinimaxModel,
        baseUrl: cfg.ttsGptsovitsBaseUrl,
        refAudioPath: cfg.ttsGptsovitsRefAudioPath,
        promptText: cfg.ttsGptsovitsPromptText,
        endpointUrl: cfg.ttsCustomCloudEndpointUrl,
        timeoutMs:
          cfg.ttsEngine === "gptsovits"
            ? cfg.ttsGptsovitsTimeoutMs
            : cfg.ttsCustomCloudTimeoutMs,
        voiceAudioPath: cfg.ttsMimoVoiceAudioPath,
        stylePrompt: cfg.ttsMimoStylePrompt,
        format: requestedFormat,
        mosslandFormat: cfg.ttsMosslandFormat,
      });
      const headerHex = result.audio.subarray(0, 4).toString("hex");
      console.log(
        "[TTS verify] engine=",
        cfg.ttsEngine,
        "format=",
        result.format,
        "header=",
        headerHex,
        "size=",
        result.audio.length,
      );
      if (channel === "feishu") {
        const audio = await (deps.convertFeishuAudio ?? convertFeishuAudioWithMpv)(
          result.audio,
          result.format,
        );
        return {
          audio,
          format: "opus",
          mime: "audio/ogg",
          extension: ".opus",
        };
      }
      const format = result.format;
      const mime = format === "wav" ? "audio/wav" : format === "pcm" ? "audio/pcm" : "audio/mpeg";
      const extension = format === "wav" ? ".wav" : format === "pcm" ? ".pcm" : ".mp3";
      return {
        audio: result.audio,
        format,
        mime,
        extension,
      };
    } catch (err) {
      console.warn("[Channels] TTS 合成失败:", err instanceof Error ? err.message : err);
      return null;
    }
  }

  return { synthesizeSession, synthesizeChannelTts };
}
