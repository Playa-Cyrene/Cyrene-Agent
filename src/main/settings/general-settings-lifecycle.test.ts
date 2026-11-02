import { CURRENT_DISCLAIMER_VERSION } from "../../shared/disclaimer";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GeneralSettings } from "./general-settings";
import type { WindowManager } from "../windows/window-manager";
import { applyGeneralSettings, handleGeneralSettingsChanged } from "./general-settings-lifecycle";
import { syncLaunchAtLogin } from "./launch-at-login";

const themeMock = vi.hoisted(() => ({ dark: false }));

vi.mock("electron", () => ({
  app: {}, nativeImage: {},
  nativeTheme: { get shouldUseDarkColors() { return themeMock.dark; } },
}));
vi.mock("../windows/broadcast", () => ({ broadcastToAllWindows: vi.fn() }));
vi.mock("../windows/window-state", () => ({ setGetCurrentAppIconPath: vi.fn() }));
vi.mock("../locale-context", () => ({ updateLocaleContext: vi.fn() }));
vi.mock("../orchestrator/mcp-manager", () => ({
  addMcpServer: vi.fn(), listMcpServers: () => [], removeMcpServer: vi.fn(),
}));
vi.mock("../app-icon", () => ({ getAppIconPath: vi.fn() }));
vi.mock("../orchestrator/tools/registry/tool-registration", () => ({ syncBuiltInToolToggles: vi.fn() }));
vi.mock("./model-settings", () => ({ loadModelSettings: vi.fn(), getPublicModelConfig: vi.fn() }));
vi.mock("./launch-at-login", () => ({ syncLaunchAtLogin: vi.fn() }));

function createHarness(petVisible = true) {
  const settings = {
    petVisible, petAlwaysOnTop: true, petZoom: 1, launchAtLogin: false,
    asrEngine: "off", searchEngine: "off", disclaimerAcceptedVersion: CURRENT_DISCLAIMER_VERSION,
  } as GeneralSettings;
  let visible = petVisible;
  const windowManager = {
    showPetWindow: vi.fn(() => { visible = true; }),
    hidePetWindow: vi.fn(() => { visible = false; }),
    setPetWindowAlwaysOnTop: vi.fn(),
    applyPetWindowZoom: vi.fn(),
    broadcast: vi.fn(),
    closeOnboardingWindow: vi.fn(),
    openReactChatWindow: vi.fn().mockResolvedValue(undefined),
  };
  const deps = {
    windowManager: windowManager as unknown as WindowManager,
    tray: null,
    screenshotService: null,
    proactiveLifecycle: { getProactiveChatService: () => null },
    broadcastToAuxWindows: vi.fn(),
  };
  return { settings, windowManager, deps, isVisible: () => visible };
}

describe("general settings window lifecycle", () => {
  beforeEach(() => vi.clearAllMocks());

  it("keeps a pet hidden from the tray hidden when changing ASR provider (#85)", () => {
    const h = createHarness();
    h.windowManager.hidePetWindow();
    handleGeneralSettingsChanged(h.settings, { ...h.settings, asrEngine: "aliyun" }, h.deps);
    expect(h.isVisible()).toBe(false);
    expect(h.windowManager.showPetWindow).not.toHaveBeenCalled();
    expect(h.windowManager.setPetWindowAlwaysOnTop).not.toHaveBeenCalled();
    expect(h.windowManager.applyPetWindowZoom).not.toHaveBeenCalled();
    expect(syncLaunchAtLogin).not.toHaveBeenCalled();
  });

  it("keeps a temporarily shown pet visible when unrelated settings are saved", () => {
    const h = createHarness(false);
    h.windowManager.showPetWindow();
    handleGeneralSettingsChanged(h.settings, { ...h.settings, asrEngine: "local" }, h.deps);
    expect(h.isVisible()).toBe(true);
    expect(h.windowManager.hidePetWindow).not.toHaveBeenCalled();
  });

  it.each([true, false])("applies an explicit visibility change to %s", (visible) => {
    const h = createHarness(!visible);
    handleGeneralSettingsChanged(h.settings, { ...h.settings, petVisible: visible }, h.deps);
    expect(h.isVisible()).toBe(visible);
    expect(visible ? h.windowManager.showPetWindow : h.windowManager.hidePetWindow).toHaveBeenCalledOnce();
  });

  it("applies changed window preferences without revealing a hidden pet", () => {
    const h = createHarness();
    h.windowManager.hidePetWindow();
    handleGeneralSettingsChanged(h.settings, {
      ...h.settings, petAlwaysOnTop: false, petZoom: 1.5, launchAtLogin: true,
    }, h.deps);
    expect(h.isVisible()).toBe(false);
    expect(h.windowManager.setPetWindowAlwaysOnTop).toHaveBeenCalledWith(false);
    expect(h.windowManager.applyPetWindowZoom).toHaveBeenCalledWith(1.5);
    expect(syncLaunchAtLogin).toHaveBeenCalledWith(true, {});
  });

  it("broadcasts the resolved theme when the saved choice changes", () => {
    const h = createHarness();
    themeMock.dark = true;
    handleGeneralSettingsChanged(
      { ...h.settings, uiTheme: "pearl-white" },
      { ...h.settings, uiTheme: "system" },
      h.deps,
    );
    expect(h.windowManager.broadcast).toHaveBeenCalledWith("ui-theme:changed", "charcoal-pink");
  });

  it.each([true, false])("fully applies startup settings with petVisible=%s", (visible) => {
    const h = createHarness(visible);
    applyGeneralSettings(h.settings, h.deps);
    expect(visible ? h.windowManager.showPetWindow : h.windowManager.hidePetWindow).toHaveBeenCalledOnce();
    expect(h.windowManager.setPetWindowAlwaysOnTop).toHaveBeenCalledWith(true);
    expect(h.windowManager.applyPetWindowZoom).toHaveBeenCalledWith(1);
    expect(syncLaunchAtLogin).toHaveBeenCalledWith(false, {});
  });
});

describe("current disclaimer lifecycle", () => {
  it.each([undefined, "", "2026-09-27"])("keeps the pet hidden before consent (%s)", version => {
    const h = createHarness();
    applyGeneralSettings({ ...h.settings, disclaimerAcceptedVersion: version } as GeneralSettings, h.deps);
    expect(h.isVisible()).toBe(false);
    expect(h.windowManager.openReactChatWindow).not.toHaveBeenCalled();
  });

  it.each([undefined, "", "2026-09-27"])("opens the workspace only after explicit acceptance (%s)", async version => {
    vi.useFakeTimers();
    try {
      const h = createHarness();
      const before = { ...h.settings, disclaimerAcceptedVersion: version } as GeneralSettings;
      applyGeneralSettings(before, h.deps);
      applyGeneralSettings(h.settings, h.deps, before);
      expect(h.windowManager.closeOnboardingWindow).not.toHaveBeenCalled();
      await vi.runAllTimersAsync();
      expect(h.windowManager.closeOnboardingWindow).toHaveBeenCalledOnce();
      expect(h.windowManager.openReactChatWindow).toHaveBeenCalledOnce();
      applyGeneralSettings(h.settings, h.deps, h.settings);
      await vi.runAllTimersAsync();
      expect(h.windowManager.openReactChatWindow).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});
