import { beforeEach, describe, expect, it, vi } from "vitest";
import { IPC } from "../../shared/ipc-channels";

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => unknown>(),
  sessions: new Map<string, { id: string; modelProfileId?: string; model?: string }>(),
  settings: {
    provider: "MiniMax（稀宇科技）",
    model: "MiniMax-M3",
    baseUrl: "https://api.minimaxi.com/anthropic",
    apiKey: "global-key",
    perProvider: {},
    modelProfiles: [{
      id: "openai-profile",
      provider: "ChatGPT（OpenAI）",
      model: "gpt-5.6",
      models: ["gpt-5.6", "gpt-5.6-mini"],
      baseUrl: "https://api.openai.com/v1",
      apiKey: "profile-key",
      explicitTransport: "openai" as const,
      reasoning: { mode: "on" as const, effort: "high" as const },
    }],
    thinkingOverride: -1 as const,
    defaultModelProfileId: undefined as string | undefined,
  },
  saveModelSettings: vi.fn(),
  saveModelProfile: vi.fn(),
  imageRead: vi.fn(),
  showSaveDialog: vi.fn(),
  copyFile: vi.fn(),
}));

vi.mock("electron", () => ({
  app: { getPath: () => "C:\\generated-image-test" },
  dialog: { showSaveDialog: mocks.showSaveDialog },
  BrowserWindow: {
    fromWebContents: vi.fn(),
    getAllWindows: () => [],
  },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: any[]) => unknown) => {
      mocks.handlers.set(channel, handler);
    }),
    on: vi.fn(),
  },
}));

vi.mock("../generated-image-store", () => ({ createGeneratedImageStore: () => ({ read: mocks.imageRead }) }));
vi.mock("node:fs/promises", async (importOriginal) => ({ ...await importOriginal<typeof import("node:fs/promises")>(), copyFile: mocks.copyFile }));

vi.mock("../settings/model-settings", async () => {
  // 复用 shared 四件套的真实语义拼出④：mock 只替换磁盘读写，不手写解析规则
  const sessionModel = await import("../../shared/session-model");
  return {
    loadModelSettings: () => mocks.settings,
    resolveModelSettingsProfile: (settings: typeof mocks.settings, id?: string) => {
      const profile = settings.modelProfiles.find((candidate) => candidate.id === id);
      return profile ? { ...settings, ...profile } : settings;
    },
    resolveSessionModelSettings: (
      settings: typeof mocks.settings,
      session: { modelProfileId?: string; model?: string },
    ) => {
      const binding = sessionModel.resolveSessionProfileBinding(settings, session);
      if (!binding.profile) return settings;
      const profile = settings.modelProfiles.find((candidate) => candidate.id === binding.resolvedProfileId);
      const expanded = profile ? { ...settings, ...profile } : settings;
      const model = sessionModel.resolveEffectiveSessionModel(session, binding);
      return model && model !== expanded.model ? { ...expanded, model } : expanded;
    },
    saveModelSettings: mocks.saveModelSettings,
    listSavedModelProfiles: (settings: typeof mocks.settings) => settings.modelProfiles,
    getDefaultModelProfile: (settings: typeof mocks.settings) =>
      settings.modelProfiles.find((candidate: { id: string }) => candidate.id === settings.defaultModelProfileId)
      ?? settings.modelProfiles[0],
    saveModelProfile: mocks.saveModelProfile,
  };
});

vi.mock("./chats-store", () => ({
  getSession: (id: string) => mocks.sessions.get(id),
  getSessionRecord: (id: string) => mocks.sessions.get(id) ?? null,
}));

describe("chat reasoning IPC", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.handlers.clear();
    mocks.sessions.clear();
    mocks.saveModelSettings.mockReset();
    mocks.saveModelProfile.mockReset();
    mocks.imageRead.mockReset();
    mocks.showSaveDialog.mockReset();
    mocks.copyFile.mockReset();
  });

  async function register() {
    const { registerChatUiIpc } = await import("./chat-ui-ipc");
    registerChatUiIpc({
      live2dWindowLifecycle: { getDiagnostics: () => ({}) },
      windowManager: null,
    });
  }

  it("saves the original only to the user-selected destination and treats dialog cancellation as non-error", async () => {
    await register();
    const save = mocks.handlers.get(IPC.CHAT_SAVE_GENERATED_IMAGE)!;
    const id = "11111111-1111-4111-8111-111111111111";
    mocks.imageRead.mockReturnValue({ filePath: "C:\\generated-image-test\\generated-images\\original", extension: "png" });
    mocks.showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: "C:\\chosen-test-output.png" });
    expect(await save({ sender: {} }, { id })).toEqual({ ok: true });
    expect(mocks.imageRead).toHaveBeenCalledWith(id, "original");
    expect(mocks.copyFile).toHaveBeenCalledWith("C:\\generated-image-test\\generated-images\\original", "C:\\chosen-test-output.png");
    mocks.copyFile.mockClear();
    mocks.showSaveDialog.mockResolvedValueOnce({ canceled: true });
    expect(await save({ sender: {} }, { id })).toEqual({ ok: false, cancelled: true });
    expect(mocks.copyFile).not.toHaveBeenCalled();
    mocks.imageRead.mockImplementationOnce(() => { throw new Error("C:\\private-path"); });
    expect(await save({ sender: {} }, { id: "../private-path" })).toEqual({ ok: false, error: "图片不存在或保存失败，请重试" });
  });

  it("reads reasoning capability from the model profile bound to the current session", async () => {
    mocks.sessions.set("session-openai", { id: "session-openai", modelProfileId: "openai-profile" });
    await register();
    const handler = mocks.handlers.get(IPC.CHAT_GET_REASONING_STATE);
    if (!handler) throw new Error("reasoning state handler was not registered");

    expect(handler({}, { sessionId: "session-openai" })).toMatchObject({
      providerKey: "ChatGPT（OpenAI）",
      providerId: "chatgpt",
      model: "gpt-5.6",
      preference: { mode: "on", effort: "high" },
      thinkingOverride: 0,
      transport: "openai",
      modelProfileId: "openai-profile",
    });
  });

  it("writes reasoning only to the model profile bound to the current session", async () => {
    mocks.sessions.set("session-openai", { id: "session-openai", modelProfileId: "openai-profile" });
    await register();
    const handler = mocks.handlers.get(IPC.CHAT_SET_REASONING);
    if (!handler) throw new Error("reasoning update handler was not registered");

    await handler({}, {
      sessionId: "session-openai",
      providerKey: "ChatGPT（OpenAI）",
      preference: { mode: "on", effort: "max" },
    });

    expect(mocks.saveModelProfile).toHaveBeenCalledWith(expect.objectContaining({
      id: "openai-profile",
      provider: "ChatGPT（OpenAI）",
      reasoning: { mode: "on", effort: "max" },
    }));
    expect(mocks.saveModelSettings).not.toHaveBeenCalled();
  });

  it("resolves the default model profile on the welcome screen instead of the empty top-level mirror", async () => {
    // 用户实际场景：顶层 provider 指向 MiniMax 但配置在档案里（顶层 model 为空壳）
    mocks.settings.model = "";
    await register();
    const handler = mocks.handlers.get(IPC.CHAT_GET_REASONING_STATE);
    if (!handler) throw new Error("reasoning state handler was not registered");

    expect(handler({}, {})).toMatchObject({
      providerKey: "ChatGPT（OpenAI）",
      model: "gpt-5.6",
      modelProfileId: "openai-profile",
    });
    mocks.settings.model = "MiniMax-M3";
  });

  it("prefers the renderer pending modelProfileId on the welcome screen", async () => {
    await register();
    const handler = mocks.handlers.get(IPC.CHAT_GET_REASONING_STATE);
    if (!handler) throw new Error("reasoning state handler was not registered");

    expect(handler({}, { modelProfileId: "openai-profile" })).toMatchObject({
      modelProfileId: "openai-profile",
      preference: { mode: "on", effort: "high" },
    });
  });

  it("writes reasoning to the default profile when no session exists (GET/SET 对称)", async () => {
    await register();
    const handler = mocks.handlers.get(IPC.CHAT_SET_REASONING);
    if (!handler) throw new Error("reasoning update handler was not registered");

    await handler({}, {
      providerKey: "ChatGPT（OpenAI）",
      modelProfileId: "openai-profile",
      preference: { mode: "on", effort: "max" },
    });

    expect(mocks.saveModelProfile).toHaveBeenCalledWith(expect.objectContaining({
      id: "openai-profile",
      reasoning: { mode: "on", effort: "max" },
    }));
    expect(mocks.saveModelSettings).not.toHaveBeenCalled();
  });

  it("rejects a reasoning write whose provider does not match the target profile", async () => {
    await register();
    const handler = mocks.handlers.get(IPC.CHAT_SET_REASONING);
    if (!handler) throw new Error("reasoning update handler was not registered");

    await handler({}, {
      providerKey: "MiniMax（稀宇科技）",
      modelProfileId: "openai-profile",
      preference: { mode: "on", effort: "max" },
    });

    expect(mocks.saveModelProfile).not.toHaveBeenCalled();
    expect(mocks.saveModelSettings).not.toHaveBeenCalled();
  });

  it("会话带清单内模型 → GET reasoning 按会话模型返回（UI 只认 effective）", async () => {
    mocks.sessions.set("session-openai", {
      id: "session-openai",
      modelProfileId: "openai-profile",
      model: "gpt-5.6-mini",
    });
    await register();
    const handler = mocks.handlers.get(IPC.CHAT_GET_REASONING_STATE);
    if (!handler) throw new Error("reasoning state handler was not registered");

    expect(handler({}, { sessionId: "session-openai" })).toMatchObject({
      model: "gpt-5.6-mini",
      modelProfileId: "openai-profile",
    });
  });

  it("#10 同档案内切模型：GET 按会话模型返回，档案 saved 偏好原样（effective 不回写 saved）", async () => {
    // 档案 saved reasoning = { on, high }；会话切到清单内小模型后：
    // 模型按会话取，推理偏好仍继承档案 saved，且 GET 不得触发任何写盘
    mocks.sessions.set("session-mini", {
      id: "session-mini",
      modelProfileId: "openai-profile",
      model: "gpt-5.6-mini",
    });
    await register();
    const handler = mocks.handlers.get(IPC.CHAT_GET_REASONING_STATE);
    if (!handler) throw new Error("reasoning state handler was not registered");

    expect(handler({}, { sessionId: "session-mini" })).toMatchObject({
      model: "gpt-5.6-mini",
      preference: { mode: "on", effort: "high" },
      modelProfileId: "openai-profile",
    });
    expect(mocks.saveModelProfile).not.toHaveBeenCalled();
    expect(mocks.saveModelSettings).not.toHaveBeenCalled();
  });

  it("会话绑定失效 → 回退默认档案默认模型，raw 会话模型不串档（#19）", async () => {
    // raw model = gpt-5.6-mini（恰好在回退档案清单里也不认——绑定失效时一并失效）
    mocks.sessions.set("session-stale", {
      id: "session-stale",
      modelProfileId: "deleted-profile",
      model: "gpt-5.6-mini",
    });
    await register();
    const handler = mocks.handlers.get(IPC.CHAT_GET_REASONING_STATE);
    if (!handler) throw new Error("reasoning state handler was not registered");

    expect(handler({}, { sessionId: "session-stale" })).toMatchObject({
      model: "gpt-5.6",
      modelProfileId: "openai-profile",
    });
  });
});
