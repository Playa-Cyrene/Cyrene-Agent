import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";

const mocks = vi.hoisted(() => ({ root: "", spawn: vi.fn(), listeners: new Map<string, () => void>() }));
vi.mock("electron", () => ({ app: {
  isPackaged: false,
  getAppPath: () => mocks.root,
  getPath: () => path.join(mocks.root, "data"),
  once: (name: string, callback: () => void) => mocks.listeners.set(name, callback),
  removeListener: (name: string) => mocks.listeners.delete(name),
} }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
import { createStartupAnimationConfig, startStartupAnimation } from "./startup-animation";

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-boot-")); mocks.root = root;
  mocks.spawn.mockReset(); mocks.listeners.clear(); vi.stubEnv("CYRENE_BOOT_ACTIVE", "");
});
afterEach(() => { vi.unstubAllEnvs(); fs.rmSync(root, { recursive: true, force: true }); });

it("creates portable packaged/development configurations that only attach", () => {
  for (const packaged of [true, false]) {
    const exe = path.join(root, "Cyrene.exe");
    const config = createStartupAnimationConfig({ exe, appPath: root, packaged, mediaDirectory: root, settingsPath: path.join(root, "settings.json") });
    expect(config.AttachOnly).toBe(true);
    expect(config.ProcessPathContains).toBe(exe);
    expect(config.AppArguments).toBe(packaged ? "" : ".");
    expect(config.Video).toBe(path.join(root, "default.mp4"));
  }
});

describe.skipIf(process.platform !== "win32")("Windows animation lifecycle", () => {
  it("uses old splash when helper is absent and bypasses a second external animation", () => {
    expect(startStartupAnimation()).toBe(false);
    vi.stubEnv("CYRENE_BOOT_ACTIVE", "1");
    expect(startStartupAnimation()).toBe(true);
    expect(mocks.spawn).not.toHaveBeenCalled();
  });
  it("disabled preference never spawns helper", () => {
    const dir = path.join(root, "data/startup-animation"); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ enabled: false }));
    expect(startStartupAnimation()).toBe(true);
    expect(mocks.spawn).not.toHaveBeenCalled();
  });
  it.each(["exit", "error"])("removes session config and quit listener on helper %s", (event) => {
    const media = path.join(root, "resources/startup-animation"); fs.mkdirSync(media, { recursive: true });
    fs.writeFileSync(path.join(media, "CyreneBoot.exe"), "test"); fs.writeFileSync(path.join(media, "default.mp4"), "test");
    const child = Object.assign(new EventEmitter(), { unref: vi.fn(), kill: vi.fn(), exitCode: null, killed: false });
    mocks.spawn.mockReturnValue(child);
    expect(startStartupAnimation()).toBe(true);
    const [helper, args, options] = mocks.spawn.mock.calls[0];
    expect(helper).toBe(path.join(media, "CyreneBoot.exe")); expect(options.windowsHide).toBe(true);
    const config = path.join(args[1], "launcher.json"); expect(fs.existsSync(config)).toBe(true);
    mocks.listeners.get("will-quit")!(); expect(child.kill).toHaveBeenCalledOnce();
    child.emit(event, event === "error" ? new Error("test spawn failure") : 0);
    expect(fs.existsSync(config)).toBe(false); expect(mocks.listeners.size).toBe(0);
  });
});
