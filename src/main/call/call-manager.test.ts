import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getAsrConfig: vi.fn(),
  createAsrStream: vi.fn(),
  synthesizeByEngine: vi.fn(),
}));

vi.mock("electron", () => ({
  BrowserWindow: class {},
  ipcMain: { on: vi.fn() },
}));

vi.mock("../asr/asr-config", () => ({
  getAsrConfig: mocks.getAsrConfig,
}));

vi.mock("../asr/asr-dispatcher", () => ({
  createAsrStream: mocks.createAsrStream,
}));

vi.mock("../tts/tts-dispatcher", () => ({
  synthesizeByEngine: mocks.synthesizeByEngine,
}));

vi.mock("../orchestrator/vendors", () => ({
  buildVendorUrl: () => "https://example.invalid/chat",
  resolveTransport: () => "openai",
  getAdapterForConfig: () => ({
    transport: "openai",
    buildRequest: () => ({ headers: {}, body: "{}" }),
    parseResponse: () => ({ text: "模型回复" }),
  }),
}));

vi.mock("../token-usage-store", () => ({
  recordRequest: vi.fn(),
  recordUsage: vi.fn(),
}));

import {
  claimExternalSpeechInput,
  endTurn,
  handleAudioFrame,
  onCallEnded,
  onTtsDone,
  releaseExternalSpeechInput,
  setCallSettings,
  setCallWindow,
  startCall,
  stopCall,
  submitExternalText,
} from "./call-manager";

describe("call turn submission", () => {
  const sentStates: string[] = [];
  const sentErrors: string[] = [];
  const sentAudio: Array<{ base64?: string; text?: string }> = [];

  beforeEach(() => {
    sentStates.length = 0;
    sentErrors.length = 0;
    sentAudio.length = 0;
    mocks.getAsrConfig.mockReset();
    mocks.createAsrStream.mockReset();
    mocks.synthesizeByEngine.mockReset();
    mocks.getAsrConfig.mockReturnValue({ engine: "mossland", apiKey: "test-key" });
    setCallWindow({
      isDestroyed: () => false,
      webContents: {
        send: (channel: string, payload: { state?: string; message?: string; base64?: string; text?: string }) => {
          if (payload.state) sentStates.push(payload.state);
          if (payload.message) sentErrors.push(payload.message);
          if (channel === "call:tts-audio") sentAudio.push(payload);
        },
      },
    } as never);
    setCallSettings(
      () => ({ provider: "openai", baseUrl: "", model: "test", apiKey: "" }),
      () => ({ ttsEngine: "off" } as never),
      async () => "",
      async () => null,
    );
  });

  afterEach(() => {
    stopCall();
    setCallWindow(null);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("leaves LISTENING immediately while batch transcription is still stopping", async () => {
    let finishStop!: (text: string) => void;
    const stopResult = new Promise<string>((resolve) => { finishStop = resolve; });
    mocks.createAsrStream.mockReturnValue({
      start: vi.fn(async () => undefined),
      sendAudio: vi.fn(),
      stop: vi.fn(() => stopResult),
    });

    startCall();
    expect(sentStates.at(-1)).toBe("LISTENING");

    const turn = endTurn();
    expect(sentStates.at(-1)).toBe("THINKING");

    finishStop("");
    await turn;
  });

  it("returns to LISTENING when batch transcription produces no text", async () => {
    mocks.createAsrStream.mockReturnValue({
      start: vi.fn(async () => undefined),
      sendAudio: vi.fn(),
      stop: vi.fn(async () => ""),
    });

    startCall();
    await endTurn();

    expect(sentStates).toContain("THINKING");
    expect(sentStates.at(-1)).toBe("LISTENING");
  });

  it("sends the assistant text with synthesized audio for the React conversation bubbles", async () => {
    let pushFinal!: (text: string) => void;
    mocks.createAsrStream.mockImplementation((_config, _partial, onFinal) => {
      pushFinal = onFinal;
      return {
        start: vi.fn(async () => undefined),
        sendAudio: vi.fn(),
        stop: vi.fn(async () => ""),
      };
    });
    mocks.synthesizeByEngine.mockResolvedValue({ audio: Buffer.from("spoken reply") });
    setCallSettings(
      () => ({ provider: "openai", baseUrl: "", model: "test", apiKey: "test-key" }),
      () => ({ ttsEngine: "minimax", ttsMinimaxKey: "key", ttsMinimaxVoiceId: "voice" } as never),
      async () => "",
      async () => null,
    );
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({}), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })));

    startCall();
    pushFinal("你好，昔涟。");
    await endTurn();

    expect(sentAudio).toEqual([{ base64: Buffer.from("spoken reply").toString("base64"), text: "模型回复" }]);
  });

  it("returns to LISTENING when batch transcription fails", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const stop = vi.fn()
      .mockRejectedValueOnce(new Error("network unavailable"))
      .mockResolvedValue("");
    mocks.createAsrStream.mockReturnValue({
      start: vi.fn(async () => undefined),
      sendAudio: vi.fn(),
      stop,
    });

    startCall();
    await endTurn();

    expect(sentStates).toContain("THINKING");
    expect(sentStates.at(-1)).toBe("LISTENING");
    consoleError.mockRestore();
  });

  it("sends the latest visible partial transcript when stop returns before a final result", async () => {
    let pushPartial!: (text: string) => void;
    mocks.createAsrStream.mockImplementation((_config, onPartial: (text: string) => void) => {
      pushPartial = onPartial;
      return {
        start: vi.fn(async () => undefined),
        sendAudio: vi.fn(),
        stop: vi.fn(() => undefined),
      };
    });
    setCallSettings(
      () => ({ provider: "openai", baseUrl: "", model: "test", apiKey: "test-key" }),
      () => ({ ttsEngine: "off" } as never),
      async () => "",
      async () => null,
    );
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({}), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    startCall();
    pushPartial("已经显示在通话窗口里的转写");
    await endTurn();

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(sentErrors).toContain("TTS 未配置：请在设置中启用 TTS 引擎");
  });

  it("reports missing model config when the getter returns no api key", async () => {
    let pushPartial!: (text: string) => void;
    mocks.createAsrStream.mockImplementation((_config, onPartial: (text: string) => void) => {
      pushPartial = onPartial;
      return {
        start: vi.fn(async () => undefined),
        sendAudio: vi.fn(),
        stop: vi.fn(() => undefined),
      };
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    startCall();
    pushPartial("用户语音");
    await endTurn();

    // 模型 getter 未返回 apiKey → 不发 LLM 请求，直接报配置缺失
    expect(fetchMock).not.toHaveBeenCalled();
    expect(sentErrors.some((msg) => msg.includes("模型配置缺失"))).toBe(true);
  });
});

describe("external speech input takeover", () => {
  const sentStates: string[] = [];
  const sentErrors: string[] = [];
  let asrStop: ReturnType<typeof vi.fn>;
  let asrSendAudio: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    sentStates.length = 0;
    sentErrors.length = 0;
    mocks.getAsrConfig.mockReset();
    mocks.createAsrStream.mockReset();
    mocks.getAsrConfig.mockReturnValue({ engine: "mossland", apiKey: "test-key" });
    asrStop = vi.fn(async () => "");
    asrSendAudio = vi.fn();
    mocks.createAsrStream.mockReturnValue({
      start: vi.fn(async () => undefined),
      sendAudio: asrSendAudio,
      stop: asrStop,
    });
    setCallWindow({
      isDestroyed: () => false,
      webContents: {
        send: (_channel: string, payload: { state?: string; message?: string }) => {
          if (payload.state) sentStates.push(payload.state);
          if (payload.message) sentErrors.push(payload.message);
        },
      },
    } as never);
    setCallSettings(
      () => ({ provider: "openai", baseUrl: "", model: "test", apiKey: "test-key" }),
      () => ({ ttsEngine: "off" } as never),
      async () => "",
      async () => null,
    );
  });

  afterEach(() => {
    stopCall();
    setCallWindow(null);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("returns null when no call is active", () => {
    expect(claimExternalSpeechInput()).toBeNull();
  });

  it("stops the builtin ASR stream and freezes the call generation on claim", () => {
    startCall();
    const claim = claimExternalSpeechInput();
    expect(claim).not.toBeNull();
    expect(asrStop).toHaveBeenCalledOnce();
    expect(handleAudioFrame(Buffer.from("audio"))).toBeUndefined();
    expect(asrSendAudio).not.toHaveBeenCalled();
  });

  it("ignores builtin VAD end-turn while external input owns the call", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    startCall();
    claimExternalSpeechInput();

    await endTurn();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(sentStates).not.toContain("THINKING");
  });

  it("feeds external text into the agent pipeline and returns to LISTENING without builtin ASR", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({}), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    startCall();
    const claim = claimExternalSpeechInput();
    expect(mocks.createAsrStream).toHaveBeenCalledOnce();

    const result = submitExternalText(claim!.callGeneration, "插件识别的外部文本");
    expect(result).toEqual({ ok: true });
    expect(sentStates.at(-1)).toBe("THINKING");

    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(sentStates.at(-1)).toBe("LISTENING");
    });
    // TTS 未配置走恢复路径；外部持有期间不重启内置 ASR
    expect(mocks.createAsrStream).toHaveBeenCalledOnce();
    expect(sentErrors).toContain("TTS 未配置：请在设置中启用 TTS 引擎");
  });

  it("rejects a second submission while a turn is in flight", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({}), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    startCall();
    const claim = claimExternalSpeechInput();

    expect(submitExternalText(claim!.callGeneration, "第一句")).toEqual({ ok: true });
    expect(submitExternalText(claim!.callGeneration, "第二句")).toEqual({
      ok: false,
      reason: "busy",
    });

    await vi.waitFor(() => {
      expect(sentStates.at(-1)).toBe("LISTENING");
    });
  });

  it("does not restart builtin ASR after TTS playback while external input owns the call", () => {
    startCall();
    const claim = claimExternalSpeechInput();
    onTtsDone();
    expect(sentStates.at(-1)).toBe("LISTENING");
    expect(mocks.createAsrStream).toHaveBeenCalledOnce();
    expect(claim).not.toBeNull();
  });

  it("restores builtin ASR when released in LISTENING state", () => {
    startCall();
    const claim = claimExternalSpeechInput();
    releaseExternalSpeechInput(claim!.callGeneration);
    expect(mocks.createAsrStream).toHaveBeenCalledTimes(2);
  });

  it("restores builtin ASR via the turn-recovery path when released mid-turn", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({}), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    startCall();
    const claim = claimExternalSpeechInput();
    submitExternalText(claim!.callGeneration, "轮次进行中释放");

    // THINKING 期间释放：不抢启内置 ASR，等轮次结束的恢复路径重启
    releaseExternalSpeechInput(claim!.callGeneration);
    expect(mocks.createAsrStream).toHaveBeenCalledOnce();

    await vi.waitFor(() => {
      expect(sentStates.at(-1)).toBe("LISTENING");
    });
    expect(mocks.createAsrStream).toHaveBeenCalledTimes(2);
  });

  it("notifies listeners and rejects submissions after the call ends", () => {
    const endedGenerations: number[] = [];
    const unsubscribe = onCallEnded((generation) => endedGenerations.push(generation));

    startCall();
    const claim = claimExternalSpeechInput();
    stopCall();

    expect(endedGenerations).toEqual([claim!.callGeneration]);
    expect(submitExternalText(claim!.callGeneration, "挂断后提交")).toEqual({
      ok: false,
      reason: "no-call",
    });

    // 新通话代次不同：旧代次的提交不允许进入新通话
    startCall();
    expect(submitExternalText(claim!.callGeneration, "旧代次提交")).toEqual({
      ok: false,
      reason: "stale-call",
    });
    unsubscribe();
  });

  it("rejects submissions from a stale generation and blank text", () => {
    startCall();
    const claim = claimExternalSpeechInput();
    expect(submitExternalText(claim!.callGeneration + 999, "旧代次")).toEqual({
      ok: false,
      reason: "stale-call",
    });
    expect(submitExternalText(claim!.callGeneration, "   ")).toEqual({
      ok: false,
      reason: "empty-text",
    });
  });

  it("rejects submissions when external input is not the owner", () => {
    startCall();
    // 接管后立即释放：代次有效但所有权已归还内置
    const claim = claimExternalSpeechInput();
    releaseExternalSpeechInput(claim!.callGeneration);
    expect(submitExternalText(claim!.callGeneration, "内置持有期间的提交")).toEqual({
      ok: false,
      reason: "not-owner",
    });
  });
});
