import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BUILT_IN_STICKER_IDS } from "../shared/sticker-types";

const state = vi.hoisted(() => ({ userData: "" }));
vi.mock("electron", () => ({ app: { getPath: () => state.userData } }));
vi.mock("fs", async (importOriginal) => ({ ...await importOriginal<typeof fs>() }));
import { addUserSticker, deleteUserSticker, getAllStickerConfig, loadUserStickerManifest } from "./sticker-storage";

let root: string;
const manifestPath = () => path.join(state.userData, "sticker-manifest.json");
const imagePath = () => path.join(state.userData, "stickers", "cat.png");
beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-sticker-delete-"));
  state.userData = path.join(root, "user-data");
  const source = path.join(root, "source.png");
  fs.writeFileSync(source, "test image");
  await addUserSticker(source, "cat", "猫", []);
  await addUserSticker(source, "other", "其他", []);
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("删除用户表情包", () => {
  it("删除图片及清单项，重新加载模块仍保持删除，保留其他记录", async () => {
    await deleteUserSticker("cat");
    expect(fs.existsSync(imagePath())).toBe(false);
    vi.resetModules();
    const storage = await import("./sticker-storage");
    expect(Object.keys(storage.loadUserStickerManifest())).toEqual(["other"]);
    expect(storage.getAllStickerConfig({}).some(item => item.id === "cat")).toBe(false);
    expect(fs.readFileSync(path.join(state.userData, "stickers", "other.png"), "utf8")).toBe("test image");
  });

  it("文件已被手动删除时仍能清理清单", async () => {
    fs.unlinkSync(imagePath());
    await deleteUserSticker("cat");
    expect(loadUserStickerManifest().cat).toBeUndefined();
  });

  it.each(["EACCES", "EPERM", "EBUSY"])("%s 删除失败必须拒绝且保留文件与清单", async code => {
    vi.spyOn(fs, "unlinkSync").mockImplementationOnce(() => { throw Object.assign(new Error(code), { code }); });
    await expect(deleteUserSticker("cat")).rejects.toThrow(code);
    expect(fs.existsSync(imagePath())).toBe(true);
    expect(loadUserStickerManifest().cat).toBeDefined();
  });

  it("清单落盘失败不报成功，保留原清单并允许重试", async () => {
    const original = fs.readFileSync(manifestPath(), "utf8");
    vi.spyOn(fs, "renameSync").mockImplementationOnce(() => { throw new Error("manifest denied"); });
    await expect(deleteUserSticker("cat")).rejects.toThrow("manifest denied");
    expect(fs.readFileSync(manifestPath(), "utf8")).toBe(original);
    expect(fs.readdirSync(state.userData).filter(file => file.endsWith(".tmp"))).toEqual([]);
    expect(fs.readFileSync(imagePath(), "utf8")).toBe("test image");
    // 普通落盘失败应恢复原图，重试仍能完成删除。
    await deleteUserSticker("cat");
    expect(Object.keys(loadUserStickerManifest())).toEqual(["other"]);
  });

  it("内置项、未知 ID 和原型属性均不能删除", async () => {
    const before = fs.readFileSync(manifestPath(), "utf8");
    for (const id of [BUILT_IN_STICKER_IDS[0], "missing", "toString", "__proto__"]) {
      await expect(deleteUserSticker(id)).rejects.toThrow();
    }
    expect(fs.readFileSync(manifestPath(), "utf8")).toBe(before);
    expect(getAllStickerConfig({})[0].builtIn).toBe(true);
  });

  it.each(["../outside.png", "..\\outside.png", "/outside.png", "C:\\outside.png", ".", "..", ""])("拒绝越界或无效路径 %s", async file => {
    const manifest = loadUserStickerManifest();
    manifest.cat.file = file;
    fs.writeFileSync(manifestPath(), JSON.stringify({ schemaVersion: 1, stickers: manifest }));
    const outside = path.join(state.userData, "outside.png");
    fs.writeFileSync(outside, "keep");
    await expect(deleteUserSticker("cat")).rejects.toThrow("路径无效");
    expect(fs.readFileSync(outside, "utf8")).toBe("keep");
    expect(loadUserStickerManifest().cat.file).toBe(file);
  });

  it("不沿 stickers 目录链接删除外部文件", async () => {
    const stickersDir = path.join(state.userData, "stickers");
    const outside = path.join(root, "outside");
    fs.renameSync(stickersDir, outside);
    fs.symlinkSync(outside, stickersDir, process.platform === "win32" ? "junction" : "dir");
    await expect(deleteUserSticker("cat")).rejects.toThrow("符号链接");
    expect(fs.existsSync(path.join(outside, "cat.png"))).toBe(true);
    fs.unlinkSync(stickersDir);
  });

  it("并发重复删除仅一次成功，不覆盖其他记录", async () => {
    const results = await Promise.allSettled([deleteUserSticker("cat"), deleteUserSticker("cat")]);
    expect(results.map(result => result.status)).toEqual(["fulfilled", "rejected"]);
    expect(Object.keys(loadUserStickerManifest())).toEqual(["other"]);
  });
});
