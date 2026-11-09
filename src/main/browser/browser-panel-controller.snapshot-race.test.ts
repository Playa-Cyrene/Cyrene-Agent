import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  captureSnapshot: vi.fn(),
  appendObservationLog: vi.fn(async () => undefined),
}));

vi.mock("./playwright-page-snapshot", () => ({
  capturePlaywrightPageSnapshot: mocks.captureSnapshot,
  cancelPlaywrightElementPicker: vi.fn(),
  readPlaywrightElementPicker: vi.fn(),
  resetPlaywrightPageSnapshot: vi.fn(),
  startPlaywrightElementPicker: vi.fn(),
  validatePlaywrightSnapshotTarget: vi.fn(),
}));
vi.mock("./browser-observation-log", () => ({ appendBrowserObservationLog: mocks.appendObservationLog }));

import { BrowserPanelController } from "./browser-panel-controller";

describe("BrowserPanelController snapshot visibility race", () => {
  it("does not restore observations or clear the re-observation guard when a capture finishes after hide and resume", async () => {
    let finishCapture!: (snapshot: { observationId: string; elements: [] }) => void;
    mocks.captureSnapshot.mockImplementation(() => new Promise((resolve) => { finishCapture = resolve; }));
    mocks.appendObservationLog.mockClear();

    const contents = { isDestroyed: () => false, isLoading: () => false };
    const tab = { id: "tab-a", kind: "web", state: { url: "https://example.com", loading: false }, view: { webContents: contents } };
    const controller = Object.assign(Object.create(BrowserPanelController.prototype), {
      readyPromise: Promise.resolve(),
      controlLease: { conversationId: "conversation-a", tabId: "tab-a" },
      controlNeedsObservation: false,
      controlAction: undefined,
      activeTabId: "tab-a",
      tabs: [tab],
      bounds: { x: 0, y: 0, width: 800, height: 600 },
      observations: new Map(),
      observationGenerations: new Map(),
      visibleBoundsWaiters: new Set(),
      controlResumeWaiters: new Set(),
      initialized: false,
      disposed: false,
      onStateChanged: vi.fn(),
    }) as BrowserPanelController;

    const pendingSnapshot = controller.getActivePageSnapshot({ conversationId: "conversation-a", runId: "run-a" });
    await Promise.resolve();
    controller.setBounds(null);
    controller.setBounds({ x: 0, y: 0, width: 800, height: 600 });
    finishCapture({ observationId: "stale-observation", elements: [] });

    const result = await pendingSnapshot;
    const state = controller as unknown as { controlNeedsObservation: boolean; observations: Map<string, unknown> };
    expect(result.ok).toBe(false);
    expect(state.controlNeedsObservation).toBe(true);
    expect(state.observations.size).toBe(0);
    expect(mocks.appendObservationLog).not.toHaveBeenCalled();
  });
});
