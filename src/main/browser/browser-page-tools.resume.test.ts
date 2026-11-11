import { beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserPanelController } from "./browser-panel-controller";
import { registerBrowserPageTools } from "./browser-page-tools";
import { toolRegistry } from "../orchestrator/tools/registry/tool-registry";

vi.mock("electron", () => ({ app: {}, session: {}, shell: {}, Menu: {}, WebContentsView: class {} }));
vi.mock("../protocols/bootstrap", () => ({ getLearnExamPageSession: vi.fn() }));

const owner = { conversationId: "resume-test-conversation", runId: "resume-test-run" };

function registerTools() {
  const controller = {
    waitForControlVisible: vi.fn(async () => "ready" as string),
    getControlState: vi.fn(() => "active"),
    hasActiveControl: vi.fn(() => true),
    getActivePageSnapshot: vi.fn(async () => ({ ok: false, reason: "unavailable" })),
    getElementCss: vi.fn(async () => "css"),
    controlOpenUrl: vi.fn(async () => JSON.stringify({ web: "https://example.test", tabId: "tab-a" })),
    controlListTabs: vi.fn(() => "[]"),
    controlSelectTab: vi.fn(() => "已绑定标签 tab-b。"),
    controlClick: vi.fn(async () => "已点击 e1。"),
    controlFill: vi.fn(async () => "已向 e1 填入文本。"),
    controlPress: vi.fn(async () => "已按下 Enter。"),
    controlScroll: vi.fn(async () => "已滚动。"),
  } as unknown as BrowserPanelController;

  registerBrowserPageTools(controller);
  const tool = (id: string) => toolRegistry.getById(id)!;
  return { controller, tool };
}

describe("browser page tools while the panel resumes", () => {
  beforeEach(() => vi.clearAllMocks());

  it("blocks a snapshot-based mutation after resume without sending input", async () => {
    const { controller, tool } = registerTools();
    vi.mocked(controller.waitForControlVisible).mockResolvedValue("resumed");

    const result = await tool("browser_click").execute({ observationId: "old", ref: "e1" }, owner);

    expect(result).toContain("页面可能在隐藏期间发生变化");
    expect(controller.controlClick).not.toHaveBeenCalled();
  });

  it("allows URL navigation and tab selection after resume", async () => {
    const { controller, tool } = registerTools();
    vi.mocked(controller.waitForControlVisible).mockResolvedValue("resumed");

    expect(await tool("browser_open_url").execute({ url: "https://example.test" }, owner)).toContain("example.test");
    expect(await tool("browser_select_tab").execute({ tabId: "tab-b" }, owner)).toContain("已绑定标签");
    expect(controller.controlOpenUrl).toHaveBeenCalledOnce();
    expect(controller.controlSelectTab).toHaveBeenCalledOnce();
  });

  it("blocks timeouts and changed-tab mutations before execution", async () => {
    const { controller, tool } = registerTools();
    vi.mocked(controller.waitForControlVisible).mockResolvedValueOnce("timed-out");
    const timedOut = await tool("browser_click").execute({ observationId: "o", ref: "e1" }, owner);
    expect(timedOut).toContain("两分钟内没有恢复");

    vi.mocked(controller.waitForControlVisible).mockResolvedValueOnce("tab-changed");
    const changedTab = await tool("browser_fill").execute({ observationId: "o", ref: "e1", value: "x" }, owner);
    expect(changedTab).toContain("切换了标签");
    expect(controller.controlClick).not.toHaveBeenCalled();
    expect(controller.controlFill).not.toHaveBeenCalled();
  });

  it("throws AbortError when cancellation arrives during the wait", async () => {
    const { controller, tool } = registerTools();
    vi.mocked(controller.waitForControlVisible).mockResolvedValue("resumed");
    const abort = new AbortController();
    abort.abort();

    await expect(tool("browser_click").execute(
      { observationId: "o", ref: "e1" }, { ...owner, signal: abort.signal },
    )).rejects.toMatchObject({ name: "AbortError" });
    expect(controller.controlClick).not.toHaveBeenCalled();
  });

  it("lets read-only tab listing continue after resume", async () => {
    const { controller, tool } = registerTools();
    vi.mocked(controller.waitForControlVisible).mockResolvedValue("resumed");

    expect(await tool("browser_list_tabs").execute({}, owner)).toBe("[]");
    expect(controller.controlListTabs).toHaveBeenCalledOnce();
  });

  it("clears the waiting indicator when the panel becomes visible", async () => {
    const controller = Object.assign(Object.create(BrowserPanelController.prototype), {
      readyPromise: Promise.resolve(),
      controlLease: { conversationId: owner.conversationId, tabId: "tab-a" },
      controlAction: "active",
      controlActionTimer: null,
      controlResumeWaiters: new Set<() => void>(),
      visibleBoundsWaiters: new Set<() => void>(),
      disposed: false,
      initialized: false,
      bounds: null,
      activeTabId: "tab-a",
      tabs: [],
      publish: vi.fn(),
    }) as BrowserPanelController;

    const pending = controller.waitForControlVisible(owner);
    await Promise.resolve();
    expect(controller.getState().controlAction).toBe("waiting");
    controller.setBounds({ x: 0, y: 0, width: 800, height: 600 });

    expect(await pending).toBe("resumed");
    expect(controller.getState().controlAction).toBe("active");
  });

  it("resets the observation guard at control lease boundaries", async () => {
    const controller = Object.assign(Object.create(BrowserPanelController.prototype), {
      readyPromise: Promise.resolve(),
      controlLease: null,
      controlNeedsObservation: true,
      controlAction: undefined,
      controlActionTimer: null,
      tabs: [{ id: "tab-a", kind: "web", view: {}, state: { url: "https://example.test" } }],
      activeTabId: "tab-a",
      bounds: { x: 0, y: 0, width: 800, height: 600 },
      publish: vi.fn(),
      retryUserAgentReloadAfterGuard: vi.fn(),
    }) as BrowserPanelController;

    expect(await controller.startControl(owner)).toContain("浏览器控制已开启");
    expect((controller as unknown as { controlNeedsObservation: boolean }).controlNeedsObservation).toBe(false);

    (controller as unknown as { controlNeedsObservation: boolean }).controlNeedsObservation = true;
    expect(controller.stopControl(owner.conversationId, owner.runId)).toContain("浏览器控制已退出");
    expect((controller as unknown as { controlNeedsObservation: boolean }).controlNeedsObservation).toBe(false);
  });

  it("restores the previous lease when tab activation fails", () => {
    const previousLease = { conversationId: owner.conversationId, tabId: "tab-a" };
    const controller = Object.assign(Object.create(BrowserPanelController.prototype), {
      controlLease: previousLease,
      controlNeedsObservation: false,
      tabs: [{ id: "tab-b", kind: "web" }],
      activateTab: vi.fn(() => false),
      setControlAction: vi.fn(),
    }) as BrowserPanelController;

    expect(controller.controlSelectTab({ ...owner, tabId: "tab-b" })).toBe("切换标签失败。");
    expect(previousLease.tabId).toBe("tab-a");
    expect((controller as unknown as { controlNeedsObservation: boolean }).controlNeedsObservation).toBe(false);
  });
});
