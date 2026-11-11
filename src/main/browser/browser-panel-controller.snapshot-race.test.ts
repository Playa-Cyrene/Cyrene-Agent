import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  captureSnapshot: vi.fn(),
  startElementPicker: vi.fn(),
  cancelElementPicker: vi.fn(),
  appendObservationLog: vi.fn(async () => undefined),
  browserSession: {
    setPermissionRequestHandler: vi.fn(),
    setPermissionCheckHandler: vi.fn(),
    on: vi.fn(),
    getUserAgent: vi.fn(() => "test-agent"),
    webRequest: { onBeforeSendHeaders: vi.fn(), onResponseStarted: vi.fn() },
    cookies: { on: vi.fn() },
  },
}));

vi.mock("electron", () => ({
  app: {},
  session: { fromPartition: () => mocks.browserSession },
  shell: {},
  Menu: {},
  WebContentsView: class {},
}));

vi.mock("./playwright-page-snapshot", () => ({
  capturePlaywrightPageSnapshot: mocks.captureSnapshot,
  cancelPlaywrightElementPicker: mocks.cancelElementPicker,
  readPlaywrightElementPicker: vi.fn(),
  resetPlaywrightPageSnapshot: vi.fn(),
  startPlaywrightElementPicker: mocks.startElementPicker,
  validatePlaywrightSnapshotTarget: vi.fn(),
}));
vi.mock("./browser-observation-log", () => ({ appendBrowserObservationLog: mocks.appendObservationLog }));
vi.mock("./browser-session-persistence", () => ({
  BrowserSessionPersistence: class { restore = vi.fn(async () => null); },
}));
vi.mock("../protocols/bootstrap", () => ({ getLearnExamPageSession: vi.fn() }));

import { BrowserPanelController } from "./browser-panel-controller";

function controllerState(controller: BrowserPanelController) {
  return controller as unknown as {
    tabs: Array<{ id: string; state: { url: string; loading: boolean }; view: unknown }>;
    activeTabId: string;
    controlLease: { conversationId: string; tabId: string } | null;
    controlNeedsObservation: boolean;
    observations: Map<string, unknown>;
  };
}

async function createVisibleController() {
  const controller = new BrowserPanelController(() => null, vi.fn(), vi.fn());
  await controller.ready();
  const state = controllerState(controller);
  const tab = state.tabs[0];
  tab.state.url = "https://example.com";
  tab.view = { webContents: { isDestroyed: () => false, isLoading: () => false } };
  state.controlLease = { conversationId: "conversation-a", tabId: tab.id };
  state.controlNeedsObservation = false;
  controller.setBounds({ x: 0, y: 0, width: 800, height: 600 });
  return { controller, state, tab };
}

describe("BrowserPanelController snapshot visibility race", () => {
  it("does not restore observations or clear the re-observation guard when a capture finishes after hide and resume", async () => {
    let finishCapture!: (snapshot: { observationId: string; elements: [] }) => void;
    mocks.captureSnapshot.mockImplementation(() => new Promise((resolve) => { finishCapture = resolve; }));
    mocks.appendObservationLog.mockClear();

    const { controller, state, tab } = await createVisibleController();

    const pendingSnapshot = controller.getActivePageSnapshot({ conversationId: "conversation-a", runId: "run-a" });
    await Promise.resolve();
    controller.setBounds(null);
    controller.setBounds({ x: 0, y: 0, width: 800, height: 600 });
    finishCapture({ observationId: "stale-observation", elements: [] });

    const result = await pendingSnapshot;
    expect(result.ok).toBe(false);
    expect(state.controlNeedsObservation).toBe(true);
    expect(state.observations.size).toBe(0);
    expect(mocks.appendObservationLog).not.toHaveBeenCalled();
  });

  it("does not register an element-picker snapshot captured before hide and resume", async () => {
    let finishPicker!: (snapshot: { observationId: string; elements: [] }) => void;
    mocks.startElementPicker.mockImplementation(() => new Promise((resolve) => { finishPicker = resolve; }));
    mocks.appendObservationLog.mockClear();
    mocks.cancelElementPicker.mockClear();
    const { controller, state } = await createVisibleController();

    const pendingPicker = controller.startElementPicker();
    await Promise.resolve();
    controller.setBounds(null);
    controller.setBounds({ x: 0, y: 0, width: 800, height: 600 });
    finishPicker({ observationId: "stale-picker-observation", elements: [] });

    expect(await pendingPicker).toBe(false);
    expect(state.observations.size).toBe(0);
    expect(mocks.appendObservationLog).not.toHaveBeenCalled();
    expect(mocks.cancelElementPicker).toHaveBeenCalledOnce();
  });
});
