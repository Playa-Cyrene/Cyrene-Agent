import { describe, expect, it, vi } from "vitest";
import type { ScreenshotHelperClient, ScreenshotResult } from "./helper-client";
import {
  createScreenshotService,
  validateScreenshotInsert,
} from "./screenshot-service";

function result(overrides: Partial<ScreenshotResult> = {}): ScreenshotResult {
  return {
    requestId: "request-1",
    filePath: null,
    width: 800,
    height: 600,
    mime: "image/png",
    clipboardWritten: true,
    hasAnnotations: false,
    ...overrides,
  };
}

function createHarness(registerResult = true) {
  const client = {
    processState: "stopped",
    captureState: "idle",
    pendingRequests: new Map(),
    ensureStarted: vi.fn().mockResolvedValue(undefined),
    start: vi.fn(),
    cancel: vi.fn(),
    shutdown: vi.fn().mockResolvedValue(undefined),
  } as unknown as ScreenshotHelperClient;
  const sendInsert = vi.fn();
  const callbacks = new Map<string, () => void>();
  const registerShortcut = vi.fn((accelerator: string, callback: () => void) => {
    if (!registerResult) return false;
    callbacks.set(accelerator, callback);
    return true;
  });
  const unregisterShortcut = vi.fn((accelerator: string) => {
    callbacks.delete(accelerator);
  });
  const service = createScreenshotService({
    client,
    sendInsert,
    registerShortcut,
    unregisterShortcut,
  });
  return {
    client,
    sendInsert,
    callbacks,
    registerShortcut,
    unregisterShortcut,
    service,
  };
}

describe("createScreenshotService", () => {
  it("maps the hotkey to clipboard-only without chat insertion", async () => {
    const harness = createHarness();
    vi.mocked(harness.client.start).mockResolvedValueOnce(result());

    await expect(harness.service.startFromHotkey()).resolves.toEqual({ ok: true });

    expect(harness.client.start).toHaveBeenCalledWith("clipboard-only", "hotkey");
    expect(harness.sendInsert).not.toHaveBeenCalled();
  });

  it("maps the chat button to clipboard-and-file with a renderer-safe preview URL", async () => {
    const harness = createHarness();
    vi.mocked(harness.client.start).mockResolvedValueOnce(
      result({
        requestId: "request-2",
        filePath: "C:\\shots\\valid.png",
        hasAnnotations: true,
      }),
    );

    await expect(harness.service.startFromChatButton()).resolves.toEqual({ ok: true });

    expect(harness.client.start).toHaveBeenCalledWith("clipboard-and-file", "chat-button");
    expect(harness.sendInsert).toHaveBeenCalledWith({
      filePath: "C:\\shots\\valid.png",
      width: 800,
      height: 600,
      mime: "image/png",
      previewUrl: "file:///C:/shots/valid.png",
      hasAnnotations: true,
    });
  });

  it("can return a button capture to the renderer that requested it", async () => {
    const harness = createHarness();
    const requestSender = vi.fn();
    vi.mocked(harness.client.start).mockResolvedValueOnce(
      result({ filePath: "C:\\shots\\react-preview.png" }),
    );

    await expect(harness.service.startFromChatButton(requestSender)).resolves.toEqual({ ok: true });

    expect(requestSender).toHaveBeenCalledOnce();
    expect(harness.sendInsert).not.toHaveBeenCalled();
  });

  it("rejects a chat result that completed without a file path", async () => {
    const harness = createHarness();
    vi.mocked(harness.client.start).mockResolvedValueOnce(result());

    await expect(harness.service.startFromChatButton()).resolves.toEqual({
      ok: false,
      reason: "SCREENSHOT_FILE_PATH_REQUIRED",
    });
    expect(harness.sendInsert).not.toHaveBeenCalled();
  });

  it("does not reject app startup when helper prewarm fails", async () => {
    const harness = createHarness();
    vi.mocked(harness.client.ensureStarted).mockRejectedValueOnce(new Error("missing helper"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(harness.service.prewarm()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      "[Screenshot] native helper prewarm failed:",
      expect.any(Error),
    );
    warn.mockRestore();
  });

  it("suspends the active shortcut while settings captures keys and resumes it", () => {
    const harness = createHarness();
    harness.service.init("Alt+Shift+S");
    expect(harness.callbacks.has("Alt+Shift+S")).toBe(true);

    harness.service.suspendHotkey();
    expect(harness.callbacks.has("Alt+Shift+S")).toBe(false);

    harness.service.resumeHotkey();
    expect(harness.callbacks.has("Alt+Shift+S")).toBe(true);
  });

  it("restores the previous shortcut when replacement registration fails", () => {
    let shouldRegister = true;
    const callbacks = new Map<string, () => void>();
    const harness = createHarness();
    harness.registerShortcut.mockImplementation((accelerator, callback) => {
      if (!shouldRegister) {
        shouldRegister = true;
        return false;
      }
      callbacks.set(accelerator, callback);
      return true;
    });
    harness.unregisterShortcut.mockImplementation((accelerator) => {
      callbacks.delete(accelerator);
    });

    harness.service.init("Alt+Shift+S");
    shouldRegister = false;
    expect(harness.service.replaceHotkey("Alt+Shift+X")).toEqual({
      ok: false,
      activeHotkey: "Alt+Shift+S",
    });
    expect(callbacks.has("Alt+Shift+S")).toBe(true);
    expect(callbacks.has("Alt+Shift+X")).toBe(false);
  });

  it("restores the previous shortcut when Electron rejects an invalid accelerator", () => {
    const harness = createHarness();
    let registrations = 0;
    harness.registerShortcut.mockImplementation(() => {
      registrations += 1;
      if (registrations === 2) throw new Error("invalid accelerator");
      return true;
    });
    harness.service.init("Alt+Shift+S");

    expect(() => harness.service.replaceHotkey("not a shortcut")).not.toThrow();
    expect(harness.service.replaceHotkey("Alt+Shift+S")).toEqual({
      ok: true,
      activeHotkey: "Alt+Shift+S",
    });
  });
});

describe("validateScreenshotInsert", () => {
  it("encodes Windows file names without treating hash and percent as URL syntax", () => {
    const data = { filePath: "C:\\user-data\\screenshots\\capture #%.png", width: 20, height: 10, mime: "image/png" as const, hasAnnotations: false };
    const insert = validateScreenshotInsert(data, "C:\\user-data\\screenshots", () => ({ isEmpty: () => false, getSize: () => ({ width: 20, height: 10 }) }));
    expect(insert?.previewUrl).toBe("file:///C:/user-data/screenshots/capture%20%23%25.png");
  });

  it("accepts only a non-empty PNG inside the fixed screenshot directory", () => {
    const data = {
      filePath: "C:\\user-data\\screenshots\\capture.png",
      width: 800,
      height: 600,
      mime: "image/png" as const,
      hasAnnotations: false,
    };

    expect(
      validateScreenshotInsert(data, "C:\\user-data\\screenshots", () => ({
        isEmpty: () => false,
        getSize: () => ({ width: 800, height: 600 }),
      })),
    ).toEqual({
      ...data,
      previewUrl: "file:///C:/user-data/screenshots/capture.png",
    });
  });

  it("rejects files outside the screenshot directory and mismatched image dimensions", () => {
    const loadImage = vi.fn(() => ({
      isEmpty: () => false,
      getSize: () => ({ width: 640, height: 480 }),
    }));

    expect(
      validateScreenshotInsert(
        {
          filePath: "C:\\user-data\\other\\capture.png",
          width: 800,
          height: 600,
          mime: "image/png",
          hasAnnotations: false,
        },
        "C:\\user-data\\screenshots",
        loadImage,
      ),
    ).toBeNull();
    expect(loadImage).not.toHaveBeenCalled();

    expect(
      validateScreenshotInsert(
        {
          filePath: "C:\\user-data\\screenshots\\capture.png",
          width: 800,
          height: 600,
          mime: "image/png",
          hasAnnotations: false,
        },
        "C:\\user-data\\screenshots",
        loadImage,
      ),
    ).toBeNull();
  });

  it("does not confuse a valid dot-prefixed file name with parent traversal", () => {
    const data = {
      filePath: "C:\\user-data\\screenshots\\..capture.png",
      width: 20,
      height: 10,
      mime: "image/png" as const,
      hasAnnotations: false,
    };

    expect(
      validateScreenshotInsert(data, "C:\\user-data\\screenshots", () => ({
        isEmpty: () => false,
        getSize: () => ({ width: 20, height: 10 }),
      })),
    ).toEqual({
      ...data,
      previewUrl: "file:///C:/user-data/screenshots/..capture.png",
    });
  });
});
