import { beforeEach, describe, expect, it, vi } from "vitest";
import { IPC } from "../../shared/ipc-channels";

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => unknown>(),
  sessions: new Map<string, { id: string; modelProfileId?: string }>(),
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
}));

vi.mock("electron", () => ({
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

vi.mock("../settings/model-settings", () => ({
  loadModelSettings: () => mocks.settings,
  resolveModelSettingsProfile: (settings: typeof mocks.settings, id?: string) => {
    const profile = settings.modelProfiles.find((candidate) => candidate.id === id);
    return profile ? { ...settings, ...profile } : settings;
  },
  saveModelSettings: mocks.saveModelSettings,
  listSavedModelProfiles: (settings: typeof mocks.settings) => settings.modelProfiles,
  getDefaultModelProfile: (settings: typeof mocks.settings) =>
    settings.modelProfiles.find((candidate: { id: string }) => candidate.id === settings.defaultModelProfileId)
      ?? settings.modelProfiles[0],
  saveModelProfile: mocks.saveModelProfile,
}));

vi.mock("./chats-store", () => ({
  getSession: (id: string) => mocks.sessions.get(id),
}));

describe("chat reasoning IPC", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.handlers.clear();
    mocks.sessions.clear();
    mocks.saveModelSettings.mockReset();
    mocks.saveModelProfile.mockReset();
  });

  async function register() {
    const { registerChatUiIpc } = await import("./chat-ui-ipc");
    registerChatUiIpc({
      live2dWindowLifecycle: { getDiagnostics: () => ({}) },
      windowManager: null,
    });
  }

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
});
