import { t } from "../../../i18n";
import type {
  StartTtsRequest,
  TtsSessionEvent,
  TtsStartResult,
} from "../../../../../shared/tts-session";
import {
  markdownToSpeechText,
  type SpeechTextOptions,
} from "../tts/markdown-to-speech-text";

export type TtsPlaybackStatus = "idle" | "synthesizing" | "playing" | "paused" | "completed" | "error";

export interface TtsPlaybackSnapshot {
  messageId: string | null;
  status: TtsPlaybackStatus;
  error?: string;
}

export interface TtsPlaybackRequest {
  conversationId: string;
  messageId: string;
  text: string;
  speechMode?: SpeechTextOptions["mode"];
  preferredAddress?: string;
  automatic?: boolean;
  onCacheKey?: (cacheKey: string, converterVersion: string) => void;
}

interface TtsSessionApi {
  startSession: (request: StartTtsRequest) => Promise<TtsStartResult>;
  cancelSession: (requestId: string) => Promise<boolean>;
  onSessionEvent: (callback: (event: TtsSessionEvent) => void) => () => void;
}

interface Live2dSpeechApi {
  prepare: () => void;
  startMouth: (durationMs: number) => void;
  stopMouth: () => void;
}

interface StreamingPlayback {
  requestId: string;
  messageId: string;
  automatic: boolean;
  converterVersion: string;
  estimatedDurationMs: number;
  onCacheKey?: (cacheKey: string, converterVersion: string) => void;
  mediaSource: MediaSource;
  sourceBuffer: SourceBuffer | null;
  // SourceBuffer.appendBuffer 要求 buffer 为 ArrayBuffer（TS 5.7 起泛型区分 ArrayBuffer/SharedArrayBuffer）
  queue: Uint8Array<ArrayBuffer>[];
  queuedBytes: number;
  ended: boolean;
  started: boolean;
  fallbackActive: boolean;
}

const MAX_STREAM_QUEUE_BYTES = 12 * 1024 * 1024;
const listeners = new Set<() => void>();
let snapshot: TtsPlaybackSnapshot = { messageId: null, status: "idle" };
let currentAudio: HTMLAudioElement | null = null;
let currentObjectUrl: string | null = null;
let currentRequestId: string | null = null;
let currentStream: StreamingPlayback | null = null;
let currentOffSessionEvent: (() => void) | null = null;
let requestGeneration = 0;

function browserApis(): { tts?: TtsSessionApi; live2dSpeech?: Live2dSpeechApi } {
  return window as typeof window & { tts?: TtsSessionApi; live2dSpeech?: Live2dSpeechApi };
}

function publish(next: TtsPlaybackSnapshot): void {
  snapshot = next;
  for (const listener of listeners) listener();
}

function unsubscribeSessionEvents(): void {
  currentOffSessionEvent?.();
  currentOffSessionEvent = null;
}

function releaseAudio(keepSessionEvents = false, keepStreamMetadata = false): void {
  if (!keepSessionEvents) unsubscribeSessionEvents();
  if (currentStream) {
    currentStream.queue.length = 0;
    currentStream.queuedBytes = 0;
    if (currentStream.sourceBuffer) currentStream.sourceBuffer.onupdateend = null;
    if (!keepStreamMetadata) currentStream = null;
  }
  if (currentAudio) {
    currentAudio.pause();
    currentAudio.onended = null;
    currentAudio.onerror = null;
    currentAudio.removeAttribute("src");
    currentAudio.load();
    currentAudio = null;
  }
  if (currentObjectUrl) {
    URL.revokeObjectURL(currentObjectUrl);
    currentObjectUrl = null;
  }
  browserApis().live2dSpeech?.stopMouth();
}

function createAudio(result: Extract<TtsStartResult, { status: "ready" }>, messageId: string): HTMLAudioElement {
  const bytes = Uint8Array.from(atob(result.base64), (character) => character.charCodeAt(0));
  const mime = result.format === "wav" ? "audio/wav" : result.format === "pcm" ? "audio/pcm" : "audio/mpeg";
  const blob = new Blob([bytes], { type: mime });
  currentObjectUrl = URL.createObjectURL(blob);
  const audio = new Audio(currentObjectUrl);
  audio.preload = "auto";
  audio.onended = () => {
    if (currentAudio !== audio) return;
    browserApis().live2dSpeech?.stopMouth();
    publish({ messageId, status: "completed" });
  };
  audio.onerror = () => {
    if (currentAudio !== audio) return;
    publish({ messageId, status: "error", error: t("ttsPlayback.playbackFailed") });
  };
  return audio;
}

function startMouth(audio: HTMLAudioElement, estimatedDurationMs?: number): void {
  const speech = browserApis().live2dSpeech;
  speech?.prepare();
  const remainingMs = Number.isFinite(audio.duration)
    ? Math.max(500, (audio.duration - audio.currentTime) * 1000)
    : Math.max(2000, estimatedDurationMs ?? 8000);
  speech?.startMouth(remainingMs);
}

async function playAudio(audio: HTMLAudioElement, messageId: string, estimatedDurationMs?: number): Promise<void> {
  await audio.play();
  if (currentAudio !== audio) return;
  startMouth(audio, estimatedDurationMs);
  publish({ messageId, status: "playing" });
}

function supportsStreamingPlayback(): boolean {
  return typeof MediaSource !== "undefined" && MediaSource.isTypeSupported("audio/mpeg");
}

function decodeBase64(base64: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
}

function failStreamingPlayback(stream: StreamingPlayback, message: string): void {
  if (currentStream !== stream) return;
  const requestId = currentRequestId;
  currentRequestId = null;
  if (requestId) void browserApis().tts?.cancelSession(requestId);
  releaseAudio();
  publish(stream.automatic
    ? { messageId: null, status: "idle" }
    : { messageId: stream.messageId, status: "error", error: message });
}

function flushStream(stream: StreamingPlayback): void {
  if (currentStream !== stream || !stream.sourceBuffer || stream.sourceBuffer.updating) return;
  const next = stream.queue.shift();
  if (next) {
    stream.queuedBytes -= next.byteLength;
    try {
      stream.sourceBuffer.appendBuffer(next);
    } catch (error) {
      failStreamingPlayback(stream, error instanceof Error ? error.message : t("ttsPlayback.streamWriteFailed"));
    }
    return;
  }
  if (stream.ended && stream.mediaSource.readyState === "open") {
    try {
      stream.mediaSource.endOfStream();
    } catch {
      // SourceBuffer may still be transitioning; the next updateend will retry.
    }
  }
}

function beginStreamingPlayback(stream: StreamingPlayback): void {
  const audio = currentAudio;
  if (!audio || currentStream !== stream || stream.started) return;
  stream.started = true;
  void playAudio(audio, stream.messageId, stream.estimatedDurationMs).catch((error) => {
    failStreamingPlayback(stream, error instanceof Error ? error.message : t("ttsPlayback.streamPlaybackFailed"));
  });
}

function prepareStreamingPlayback(
  requestId: string,
  request: TtsPlaybackRequest,
  converterVersion: string,
): StreamingPlayback {
  const mediaSource = new MediaSource();
  currentObjectUrl = URL.createObjectURL(mediaSource);
  const audio = new Audio(currentObjectUrl);
  audio.preload = "auto";
  currentAudio = audio;
  const stream: StreamingPlayback = {
    requestId,
    messageId: request.messageId,
    automatic: Boolean(request.automatic),
    converterVersion,
    estimatedDurationMs: Math.max(2000, Array.from(request.text).length * 180),
    onCacheKey: request.onCacheKey,
    mediaSource,
    sourceBuffer: null,
    queue: [],
    queuedBytes: 0,
    ended: false,
    started: false,
    fallbackActive: false,
  };
  currentStream = stream;
  audio.onended = () => {
    if (currentAudio !== audio || currentStream !== stream) return;
    browserApis().live2dSpeech?.stopMouth();
    publish({ messageId: stream.messageId, status: "completed" });
  };
  audio.onerror = () => failStreamingPlayback(stream, t("ttsPlayback.streamPlaybackFailed"));
  mediaSource.addEventListener("sourceopen", () => {
    if (currentStream !== stream || stream.fallbackActive) return;
    try {
      const sourceBuffer = mediaSource.addSourceBuffer("audio/mpeg");
      sourceBuffer.mode = "sequence";
      sourceBuffer.onupdateend = () => {
        if (currentStream !== stream) return;
        if (!stream.started && sourceBuffer.buffered.length > 0) beginStreamingPlayback(stream);
        flushStream(stream);
      };
      stream.sourceBuffer = sourceBuffer;
      flushStream(stream);
    } catch (error) {
      failStreamingPlayback(stream, error instanceof Error ? error.message : t("ttsPlayback.streamUnsupported"));
    }
  }, { once: true });
  browserApis().live2dSpeech?.prepare();
  return stream;
}

function handleStreamingEvent(event: TtsSessionEvent): void {
  const stream = currentStream;
  if (!stream || event.requestId !== stream.requestId || currentRequestId !== stream.requestId) return;
  if (event.type === "audio-chunk") {
    if (stream.fallbackActive) return;
    const chunk = decodeBase64(event.base64);
    if (stream.queuedBytes + chunk.byteLength > MAX_STREAM_QUEUE_BYTES) {
      failStreamingPlayback(stream, t("ttsPlayback.streamBufferOverflow"));
      return;
    }
    stream.queue.push(chunk);
    stream.queuedBytes += chunk.byteLength;
    flushStream(stream);
    return;
  }
  if (event.type === "stream-completed") {
    currentRequestId = null;
    unsubscribeSessionEvents();
    stream.onCacheKey?.(event.cacheKey, stream.converterVersion);
    stream.ended = true;
    flushStream(stream);
    return;
  }
  if (event.type === "fallback-started") {
    stream.fallbackActive = true;
    releaseAudio(true, true);
    publish({ messageId: stream.messageId, status: "synthesizing" });
    return;
  }
  if (event.type === "fallback-ready") {
    currentRequestId = null;
    releaseAudio();
    stream.onCacheKey?.(event.cacheKey, stream.converterVersion);
    const result: Extract<TtsStartResult, { status: "ready" }> = {
      requestId: event.requestId,
      status: "ready",
      base64: event.base64,
      cacheKey: event.cacheKey,
      format: event.format,
      cached: false,
    };
    const audio = createAudio(result, stream.messageId);
    currentAudio = audio;
    void playAudio(audio, stream.messageId).catch((error) => {
      publish(stream.automatic
        ? { messageId: null, status: "idle" }
        : { messageId: stream.messageId, status: "error", error: error instanceof Error ? error.message : String(error) });
    });
    return;
  }
  if (event.type === "error") failStreamingPlayback(stream, event.message);
}

export function getTtsPlaybackSnapshot(): TtsPlaybackSnapshot {
  return snapshot;
}

export function subscribeTtsPlayback(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function stopTtsPlayback(): void {
  requestGeneration += 1;
  const requestId = currentRequestId;
  currentRequestId = null;
  if (requestId) void browserApis().tts?.cancelSession(requestId);
  releaseAudio();
  publish({ messageId: null, status: "idle" });
}

export async function startTtsPlayback(request: TtsPlaybackRequest): Promise<void> {
  const api = browserApis().tts;
  if (!api) {
    if (!request.automatic) publish({ messageId: request.messageId, status: "error", error: t("ttsPlayback.serviceNotReady") });
    return;
  }

  stopTtsPlayback();
  const generation = ++requestGeneration;
  const requestId = crypto.randomUUID();
  const speech = markdownToSpeechText(request.text, {
    mode: request.speechMode,
    preferredAddress: request.preferredAddress,
  });
  if (!speech.text) {
    if (!request.automatic) publish({ messageId: request.messageId, status: "error", error: t("ttsPlayback.noReadableContent") });
    return;
  }
  currentRequestId = requestId;
  publish({ messageId: request.messageId, status: "synthesizing" });

  const earlyEvents: TtsSessionEvent[] = [];
  let eventHandler: ((event: TtsSessionEvent) => void) | null = null;
  currentOffSessionEvent = api.onSessionEvent((event) => {
    if (event.requestId !== requestId) return;
    if (eventHandler) eventHandler(event);
    else earlyEvents.push(event);
  });

  try {
    const result = await api.startSession({
      requestId,
      conversationId: request.conversationId,
      messageId: request.messageId,
      speechText: speech.text,
      converterVersion: speech.converterVersion,
      automatic: request.automatic,
      supportsStreamingPlayback: supportsStreamingPlayback(),
    });
    if (generation !== requestGeneration || currentRequestId !== requestId || result.requestId !== requestId) return;
    if (result.status === "streaming") {
      prepareStreamingPlayback(requestId, request, speech.converterVersion);
      eventHandler = handleStreamingEvent;
      earlyEvents.splice(0).forEach(handleStreamingEvent);
      return;
    }
    currentRequestId = null;
    unsubscribeSessionEvents();
    if (result.status !== "ready") {
      publish({ messageId: null, status: "idle" });
      return;
    }
    request.onCacheKey?.(result.cacheKey, speech.converterVersion);
    const audio = createAudio(result, request.messageId);
    currentAudio = audio;
    await playAudio(audio, request.messageId);
  } catch (error) {
    if (generation !== requestGeneration || currentRequestId !== requestId) return;
    currentRequestId = null;
    releaseAudio();
    if (request.automatic) {
      publish({ messageId: null, status: "idle" });
      return;
    }
    publish({
      messageId: request.messageId,
      status: "error",
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Starts one automatic queue item and resolves only when that exact message audio reaches a terminal state. */
export async function playTtsToCompletion(request: TtsPlaybackRequest): Promise<
  "completed" | "skipped" | "interrupted" | "error"
> {
  await startTtsPlayback(request);
  const initial = getTtsPlaybackSnapshot();
  if (initial.messageId !== request.messageId) return initial.status === "error" ? "error" : "skipped";
  if (initial.status === "completed") return "completed";
  if (initial.status === "error") return "error";
  return await new Promise((resolve) => {
    const check = () => {
      const current = getTtsPlaybackSnapshot();
      if (current.messageId === request.messageId && current.status === "completed") {
        off();
        resolve("completed");
      } else if (current.messageId === request.messageId && current.status === "error") {
        off();
        resolve("error");
      } else if (current.messageId !== request.messageId || current.status === "idle") {
        off();
        resolve("interrupted");
      }
    };
    const off = subscribeTtsPlayback(check);
    check();
  });
}

export async function toggleTtsPlayback(request: TtsPlaybackRequest): Promise<void> {
  const isCurrent = snapshot.messageId === request.messageId;
  if (isCurrent && snapshot.status === "playing" && currentAudio) {
    currentAudio.pause();
    browserApis().live2dSpeech?.stopMouth();
    publish({ messageId: request.messageId, status: "paused" });
    return;
  }
  if (isCurrent && snapshot.status === "paused" && currentAudio) {
    try {
      await playAudio(currentAudio, request.messageId, currentStream?.estimatedDurationMs);
    } catch (error) {
      publish({ messageId: request.messageId, status: "error", error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }
  if (isCurrent && snapshot.status === "completed" && currentAudio) {
    currentAudio.currentTime = 0;
    try {
      await playAudio(currentAudio, request.messageId, currentStream?.estimatedDurationMs);
    } catch (error) {
      publish({ messageId: request.messageId, status: "error", error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }
  await startTtsPlayback(request);
}
