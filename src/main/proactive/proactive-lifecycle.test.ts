import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProactiveChatServiceDeps } from "./proactive-service";
import type { GeneralSettings } from "../settings/general-settings";
import type { ConversationJournalService } from "../orchestrator/conversation-journal-service";
import type { ModelSettings } from "../settings/model-settings";

const mocks = vi.hoisted(() => ({
  deps: null as ProactiveChatServiceDeps | null,
  settings: {} as ModelSettings,
  listSessions: vi.fn(),
  getSessionRecord: vi.fn(),
  getOrCreateSessionByPurpose: vi.fn(),
  runModel: vi.fn(),
}));
vi.mock("electron", () => ({ app: { getPath: () => "/tmp/cyrene-test" }, powerMonitor: { on: vi.fn() } }));
vi.mock("../chats/chats-store", () => ({
  listSessions: mocks.listSessions,
  getSessionRecord: mocks.getSessionRecord,
  getOrCreateSessionByPurpose: mocks.getOrCreateSessionByPurpose,
}));
vi.mock("../chats/chats-ipc", () => ({ broadcastChatsChanged: vi.fn() }));
vi.mock("../channels/init", () => ({ setChannelsConversationLifecycle: vi.fn() }));
vi.mock("../channels/manager", () => ({ channelManager: {} }));
vi.mock("../channels/proactive-delivery", () => ({
  canStartProactiveChannelDelivery: vi.fn(), sendProactiveChannelMessage: vi.fn(),
}));
vi.mock("../orchestrator", () => ({ buildAlwaysOnContext: vi.fn(), buildMemoryInjection: vi.fn() }));
vi.mock("../prompts/prompt-loader", () => ({ loadPromptFile: vi.fn() }));
vi.mock("../settings/model-settings", async (importOriginal) => ({
  ...await importOriginal<typeof import("../settings/model-settings")>(),
  loadModelSettings: () => mocks.settings,
}));
vi.mock("./proactive-state-store", () => ({ loadProactiveState: vi.fn(), saveProactiveState: vi.fn() }));
vi.mock("./proactive-trigger", () => ({ createProactiveTrigger: vi.fn() }));
vi.mock("./proactive-model", () => ({ runProactiveModel: mocks.runModel }));
vi.mock("./proactive-service", () => ({
  createProactiveChatService: (deps: ProactiveChatServiceDeps) => { mocks.deps = deps; return {}; },
}));

import { createProactiveLifecycle } from "./proactive-lifecycle";
import { normalizeModelSettings, resolveSessionModelSettings } from "../settings/model-settings";

const defaultProfile = {
  id: "default", provider: "OpenAI", baseUrl: "https://default.example.test/v1", model: "default-model", apiKey: "default-test-key",
  explicitTransport: "openai" as const, reasoning: { mode: "off" as const },
};
const boundProfile = {
  id: "bound", provider: "custom", baseUrl: "https://bound.example.test/v1", model: "bound-default", apiKey: "bound-test-key",
  explicitTransport: "anthropic" as const, reasoning: { mode: "on" as const, effort: "high" as const }, models: ["bound-default", "bound-selected"],
  modelOptions: { "bound-selected": { manualReasoning: { style: "anthropic-adaptive", supportedEfforts: ["high"], defaultEffort: "high", supportsDisable: true } } },
};
const messages = [{ role: "user" as const, content: "test" }];
let general: GeneralSettings;

function run(target?: "local" | "wechat" | "feishu") { return mocks.deps!.runModel(messages, target); }
function expectResolved(session = {}) {
  const expected = resolveSessionModelSettings(mocks.settings, session);
  expect(mocks.runModel).toHaveBeenLastCalledWith({
    settings: Object.fromEntries(["provider", "baseUrl", "model", "apiKey", "explicitTransport", "reasoning", "manualReasoning"].map((key) => [key, expected[key as keyof ModelSettings]])),
    messages, timeoutMs: 45_000,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.settings = normalizeModelSettings({
    provider: "OpenAI", apiKey: "", baseUrl: "https://stale.example.test/v1", model: "stale-model",
    modelProfiles: [defaultProfile, boundProfile], defaultModelProfileId: "default",
  } as never);
  mocks.listSessions.mockResolvedValue([]);
  mocks.getSessionRecord.mockResolvedValue(null);
  mocks.runModel.mockResolvedValue({ kind: "silent" });
  general = { proactiveDeliveryTarget: "local" } as GeneralSettings;
  createProactiveLifecycle({ loadGeneralSettings: () => general, conversationJournal: {} as ConversationJournalService }).initializeProactiveChatService();
});

describe("proactive delivery uses Chat model resolution", () => {
  it("uses the default saved profile despite an empty top-level key, without creating a conversation", async () => {
    expect(mocks.settings.apiKey).toBe("");
    await expect(run("local")).resolves.toEqual({ kind: "silent" });
    expectResolved();
    expect(mocks.runModel.mock.calls[0][0].settings.apiKey).toBe("default-test-key");
    expect(mocks.getOrCreateSessionByPurpose).not.toHaveBeenCalled();
  });

  it("reads edits to the default profile on every generation without refreshing the mirror", async () => {
    await run("local");
    mocks.settings.modelProfiles![0] = { ...mocks.settings.modelProfiles![0], apiKey: "edited-key", baseUrl: "https://edited.example.test/v1", model: "edited-model" };
    await run("local");
    expectResolved();
    expect(mocks.runModel.mock.calls[1][0].settings).toMatchObject({ apiKey: "edited-key", model: "edited-model", baseUrl: "https://edited.example.test/v1" });
    expect(mocks.settings.apiKey).toBe("");
  });

  it("uses the local proactive conversation binding and selected submodel, not the latest ordinary chat", async () => {
    mocks.listSessions.mockResolvedValue([{ id: "ordinary" }, { id: "proactive", purpose: "proactive-chat" }]);
    const session = { modelProfileId: "bound", model: "bound-selected" };
    mocks.getSessionRecord.mockResolvedValue(session);
    await run("local");
    expect(mocks.getSessionRecord).toHaveBeenCalledWith("proactive");
    expectResolved(session);
    expect(mocks.runModel.mock.calls[0][0].settings).toMatchObject({ model: "bound-selected", apiKey: "bound-test-key", explicitTransport: "anthropic", reasoning: { mode: "on", effort: "high" }, manualReasoning: { style: "anthropic-adaptive", supportedEfforts: ["high"], defaultEffort: "high", supportsDisable: true } });
  });

  it.each(["wechat", "feishu"] as const)("uses the default profile for %s like ordinary channel Chat", async (target) => {
    // Real channel history IDs are not Chat records. Even a desktop history
    // binding does not make ordinary channel Chat inherit its model profile.
    const channelSessionId = `channel:${target}:0123456789abcdef`;
    mocks.getSessionRecord.mockImplementation(async (id: string) => id === channelSessionId ? null : { modelProfileId: "bound", model: "bound-selected" });
    await expect(run(target)).resolves.toEqual({ kind: "silent" });
    expect(mocks.getSessionRecord).not.toHaveBeenCalled();
    expect(mocks.listSessions).not.toHaveBeenCalled();
    expectResolved();
    expect(mocks.runModel.mock.calls[0][0].settings.apiKey).toBe("default-test-key");
  });

  it("falls back to the bound profile model when its saved submodel is no longer selectable", async () => {
    mocks.listSessions.mockResolvedValue([{ id: "proactive", purpose: "proactive-chat" }]);
    mocks.getSessionRecord.mockResolvedValue({ modelProfileId: "bound", model: "removed-submodel" });
    await run("local");
    expect(mocks.runModel.mock.calls[0][0].settings).toMatchObject({ model: "bound-default", apiKey: "bound-test-key" });
    expect(mocks.runModel.mock.calls[0][0].settings.manualReasoning).toBeUndefined();
  });

  it("drops a deleted binding and its old model together when falling back to the default", async () => {
    mocks.listSessions.mockResolvedValue([{ id: "proactive", purpose: "proactive-chat" }]);
    mocks.getSessionRecord.mockResolvedValue({ modelProfileId: "deleted", model: "old-model" });
    await run("local");
    expectResolved();
    expect(mocks.runModel.mock.calls[0][0].settings.model).toBe("default-model");
  });

  it("uses the first saved profile when the configured default was deleted", async () => {
    mocks.settings.defaultModelProfileId = "deleted";
    await run("local");
    expectResolved();
    expect(mocks.runModel.mock.calls[0][0].settings.apiKey).toBe("default-test-key");
  });

  it("preserves legacy top-level settings when there are no saved profiles", async () => {
    mocks.settings.modelProfiles = [];
    mocks.settings.apiKey = "legacy-key";
    await run("local");
    expectResolved();
    expect(mocks.runModel.mock.calls[0][0].settings.model).toBe("stale-model");
  });

  it("does not borrow another profile or the top-level key if the selected profile has no key", async () => {
    mocks.settings.apiKey = "stale-key";
    mocks.settings.modelProfiles![0].apiKey = "";
    await expect(run("local")).resolves.toEqual({ kind: "error", reason: "missing_api_key" });
    expect(mocks.runModel).not.toHaveBeenCalled();
  });

  it("fails closed when an indexed local proactive conversation has been deleted", async () => {
    mocks.listSessions.mockResolvedValue([{ id: "deleted", purpose: "proactive-chat" }]);
    await expect(run("local")).resolves.toEqual({ kind: "error", reason: "session_unavailable" });
    expect(mocks.runModel).not.toHaveBeenCalled();
  });

  it("does not silently switch to the default if destination metadata cannot be read", async () => {
    mocks.listSessions.mockResolvedValue([{ id: "proactive", purpose: "proactive-chat" }]);
    mocks.getSessionRecord.mockRejectedValueOnce(new Error("storage-unavailable"));
    await expect(run("local")).rejects.toThrow("storage-unavailable");
    expect(mocks.runModel).not.toHaveBeenCalled();
    expect(mocks.getOrCreateSessionByPurpose).not.toHaveBeenCalled();
  });

  it("uses the frozen route even if general settings now select another channel", async () => {
    general.proactiveDeliveryTarget = "wechat";
    await run("local");
    expect(mocks.listSessions).toHaveBeenCalled();
    expectResolved();
  });
});
