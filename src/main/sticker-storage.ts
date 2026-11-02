// 用户表情包存储管理
// 负责 userData/sticker-manifest.json 的增删查
// 和 userData/stickers/ 目录下的图片文件管理

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { randomUUID } from "crypto";
import { app } from "electron";
import { BUILT_IN_STICKER_FILES, BUILT_IN_STICKER_DESCRIPTIONS } from "./sticker-descriptions";
import { BUILT_IN_STICKER_IDS } from "../shared/sticker-types";
import type { UserStickerMeta, StickerConfigItem } from "../shared/sticker-types";
import { buildLocalStickerUrl, resolveLocalStickerPath } from "./sticker-protocol";

// ── 路径 ──

export function getStickersDir(): string {
  return path.join(app.getPath("userData"), "stickers");
}

function getManifestPath(): string {
  return path.join(app.getPath("userData"), "sticker-manifest.json");
}

// ── Manifest 读写 ──

interface ManifestFile {
  schemaVersion: number;
  stickers: Record<string, UserStickerMeta>;
}

export function loadUserStickerManifest(): Record<string, UserStickerMeta> {
  try {
    const filePath = getManifestPath();
    if (!fs.existsSync(filePath)) return {};
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as ManifestFile;
    return raw.stickers ?? {};
  } catch (err) {
    console.error("[stickers] load manifest failed:", err);
    return {};
  }
}

function saveUserStickerManifest(stickers: Record<string, UserStickerMeta>): void {
  const filePath = getManifestPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const data: ManifestFile = { schemaVersion: 1, stickers };
  // 写入失败时保留原清单，避免删除一项时破坏其余表情包记录。
  const tempPath = `${filePath}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), { encoding: "utf8", flag: "wx" });
    fs.renameSync(tempPath, filePath);
  } catch (err) {
    fs.rmSync(tempPath, { force: true });
    throw err;
  }
}

// ── 增删查 ──

/** 检查 id 是否已被占用 */
export function isStickerIdTaken(id: string): boolean {
  if (BUILT_IN_STICKER_IDS.includes(id as any)) return true;
  const manifest = loadUserStickerManifest();
  return id in manifest;
}

/** 添加用户表情包：复制文件 + 写入 manifest */
export async function addUserSticker(
  sourceFilePath: string,
  id: string,
  description: string,
  phrases: string[],
): Promise<void> {
  // 检查 id
  if (isStickerIdTaken(id)) {
    throw new Error(`表情包 ID "${id}" 已存在`);
  }

  // 获取扩展名
  const ext = path.extname(sourceFilePath).toLowerCase();
  if (![".png", ".jpg", ".jpeg", ".gif", ".webp"].includes(ext)) {
    throw new Error(`不支持的图片格式: ${ext}`);
  }

  // 复制文件到 userData/stickers/
  const stickersDir = getStickersDir();
  fs.mkdirSync(stickersDir, { recursive: true });
  const destFile = `${id}${ext}`;
  const destPath = path.join(stickersDir, destFile);
  fs.copyFileSync(sourceFilePath, destPath);

  // 写入 manifest
  const manifest = loadUserStickerManifest();
  manifest[id] = {
    id,
    file: destFile,
    description,
    phrases,
    createdAt: Date.now(),
  };
  saveUserStickerManifest(manifest);
}

/** 删除用户表情包：删除文件 + 从 manifest 移除 */
export async function deleteUserSticker(id: string): Promise<void> {
  // 内置 sticker 不允许删除
  if (BUILT_IN_STICKER_IDS.includes(id as any)) {
    throw new Error(`内置表情包 "${id}" 不能删除，只能禁用`);
  }

  const manifest = loadUserStickerManifest();
  const meta = Object.hasOwn(manifest, id) ? manifest[id] : undefined;
  if (!meta) throw new Error(`表情包 "${id}" 不存在`);

  // 删除文件
  const filePath = typeof meta.file === "string"
    ? resolveLocalStickerPath(getStickersDir(), meta.file)
    : null;
  if (!filePath) throw new Error("表情包文件路径无效");
  let originalImage: Buffer | undefined;
  try {
    // 不沿链接读写其他位置的文件，回滚也不能覆盖链接指向的目标。
    if (fs.lstatSync(getStickersDir()).isSymbolicLink() || fs.lstatSync(filePath).isSymbolicLink()) {
      throw new Error("表情包路径不能是符号链接");
    }
    originalImage = fs.readFileSync(filePath);
    fs.unlinkSync(filePath);
  } catch (err) {
    // 仅容忍已被手动删除的文件；权限、占用等错误必须反馈给用户。
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  // 从 manifest 移除
  delete manifest[id];
  try {
    saveUserStickerManifest(manifest);
  } catch (err) {
    // 清单未提交时恢复图片；只创建缺失文件，不能覆写外部并发写入的内容。
    if (originalImage) {
      try {
        fs.writeFileSync(filePath, originalImage, { flag: "wx" });
      } catch (restoreError) {
        throw new Error(`清单保存失败且图片恢复失败，请检查表情包目录：${String(err)}；${String(restoreError)}`);
      }
    }
    throw err;
  }
}

/** 获取所有 sticker 的配置（内置 + 用户），供表情包管理窗口/设置面板使用 */
export function getAllStickerConfig(
  stickerSettings: Record<string, boolean>,
): StickerConfigItem[] {
  const items: StickerConfigItem[] = [];

  // 内置
  for (const id of BUILT_IN_STICKER_IDS) {
    const file = BUILT_IN_STICKER_FILES[id];
    const desc = BUILT_IN_STICKER_DESCRIPTIONS[id];
    items.push({
      id,
      src: `/stickers/${file}`,
      enabled: stickerSettings[id] !== false,
      builtIn: true,
      description: desc ? desc.phrases.join("，") : id,
    });
  }

  // 用户添加的
  const manifest = loadUserStickerManifest();
  for (const [id, meta] of Object.entries(manifest)) {
    items.push({
      id,
      src: getLocalStickerUrl(meta.file),
      enabled: stickerSettings[id] !== false,
      builtIn: false,
      description: meta.phrases.length > 0 ? meta.phrases.join("，") : meta.description,
    });
  }

  return items;
}

/** 获取用户 sticker 图片的本地协议 URL */
export function getLocalStickerUrl(file: string): string {
  return buildLocalStickerUrl(file);
}

/** 获取用户 sticker 文件的本地磁盘路径 */
export function getUserStickerFilePath(file: string): string {
  return path.join(getStickersDir(), file);
}
