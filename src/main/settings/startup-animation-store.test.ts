import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { StartupAnimationStore } from "./startup-animation-store";

let root: string;
let store: StartupAnimationStore;
function box(name: string, payload: Buffer) {
  const header = Buffer.alloc(8); header.writeUInt32BE(payload.length + 8); header.write(name, 4);
  return Buffer.concat([header, payload]);
}
function video() {
  const file = path.join(root, "my-video.mp4");
  fs.writeFileSync(file, Buffer.concat([box("ftyp", Buffer.from("isom0000")), box("moov", Buffer.alloc(4)), box("mdat", Buffer.alloc(32))]));
  return file;
}
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-animation-")); store = new StartupAnimationStore(path.join(root, "data")); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

describe("startup animation preferences", () => {
  it("defaults on, persists false, and rejects non-boolean toggle values", () => {
    expect(store.read()).toEqual({ enabled: true, videoFile: null, videoName: null });
    store.setEnabled(false);
    expect(new StartupAnimationStore(store.directory).read().enabled).toBe(false);
    expect(() => store.setEnabled("false")).toThrow();
  });
  it("copies imported video, survives source removal, and restores default without turning on", async () => {
    store.setEnabled(false);
    const source = video();
    const saved = await store.importVideo(source);
    expect(saved.enabled).toBe(false);
    const copied = path.join(store.directory, saved.videoFile!);
    expect(fs.readFileSync(copied)).toEqual(fs.readFileSync(source));
    fs.unlinkSync(source);
    expect(store.read().videoName).toBe("my-video.mp4");
    expect(store.resetVideo()).toEqual({ enabled: false, videoFile: null, videoName: null });
    expect(fs.existsSync(copied)).toBe(true); // Existing playback keeps its open media.
  });
  it("invalid or truncated imports leave the previous video untouched and clean the partial copy", async () => {
    const source = video();
    const previous = await store.importVideo(source);
    fs.writeFileSync(source, Buffer.alloc(30, 0x61));
    await expect(store.importVideo(source)).rejects.toThrow();
    expect(store.read()).toEqual(previous);
    expect(fs.readdirSync(store.directory).filter((name) => name.endsWith(".mp4"))).toEqual([previous.videoFile]);
  });
  it("rejects paths in preference files and falls back when custom media is missing", () => {
    fs.mkdirSync(store.directory);
    fs.writeFileSync(store.settingsPath, JSON.stringify({ enabled: false, videoFile: "../secret.mp4", videoName: "bad" }));
    expect(store.read()).toEqual({ enabled: false, videoFile: null, videoName: null });
    fs.writeFileSync(store.settingsPath, JSON.stringify({ videoFile: "12345678-1234-1234-1234-123456789012.mp4" }));
    expect(store.read().videoFile).toBeNull();
  });
});
