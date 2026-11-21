// 第三方 skills 快照安装：首启把 vendor/cyrene-skills/skills-snapshot.zip
// 解压到 userData/skills（user 区），让应用拿到完整 skill 集合。
//
// 背景：仓库 skills/ 只保留自研 cyrene-*，第三方 skill 打成 zip 快照随仓库/
// 安装包分发（见 scripts/packaging/build-skills-snapshot.mjs）。本模块在
// initSkills 扫描前调用，用哨兵文件保证只安装一次：
//   - 哨兵存在 → 跳过（已装过，不重复覆盖）
//   - 目标目录已有用户内容 → 跳过并写哨兵（不覆盖用户手动放的 skill）
//   - 否则在独立暂存目录解压并写哨兵，再整体提交
//
// 纯函数模块：不直接碰 electron，归档路径由调用方解析传入（见
// external-content-paths.resolveSkillsSnapshotArchivePath）。

import * as fs from "node:fs";
import * as path from "node:path";
import { logger, LogTag } from "../logger";

/** 安装完成的哨兵文件名（写进 userSkillsDir）。 */
export const SNAPSHOT_SENTINEL = ".snapshot-installed";

export interface SnapshotInstallOptions {
  /** 快照 zip 的绝对路径（null/不存在 → no_archive）。 */
  archivePath: string | null;
  /** 解压目标目录（user 区，即 userData/skills）。 */
  userSkillsDir: string;
  existsSync?: (p: string) => boolean;
  mkdirSync?: (p: string, opts?: { recursive?: boolean }) => void;
  writeFileSync?: (p: string, content: string) => void;
  readdirSync?: (p: string) => string[];
  mkdtempSync?: (prefix: string) => string;
  rmdirSync?: (p: string) => void;
  renameSync?: (from: string, to: string) => void;
  rmSync?: (p: string, opts: { recursive: true; force: true }) => void;
  extract?: (archivePath: string, opts: { dir: string }) => Promise<void>;
}

export type SnapshotInstallStatus =
  | "no_archive"      // 找不到快照归档（开发版未生成等），跳过
  | "skipped_sentinel" // 已安装过，哨兵存在
  | "skipped_existing" // 目标目录已有用户内容，不覆盖
  | "installed"       // 首次解压成功
  | "failed";         // 解压异常（记录但不应阻断启动）

/** 已安装标记（哨兵）路径。 */
export function snapshotSentinelPath(userSkillsDir: string): string {
  return path.join(userSkillsDir, SNAPSHOT_SENTINEL);
}

/**
 * 安装第三方 skills 快照（幂等）。解压失败返回 "failed" 但调用方不应因此
 * 阻断应用启动——只是少一部分 skill，功能主体不受影响。
 */
export async function installSkillsSnapshot(options: SnapshotInstallOptions): Promise<SnapshotInstallStatus> {
  const {
    archivePath,
    userSkillsDir,
    existsSync = (p) => fs.existsSync(p),
    mkdirSync = (p, opts) => fs.mkdirSync(p, opts),
    writeFileSync = (p, c) => fs.writeFileSync(p, c, "utf8"),
    readdirSync = (p) => fs.readdirSync(p),
    mkdtempSync = (prefix) => fs.mkdtempSync(prefix),
    rmdirSync = (p) => fs.rmdirSync(p),
    renameSync = (from, to) => fs.renameSync(from, to),
    rmSync = (p, opts) => fs.rmSync(p, opts),
    extract = async (a, o) => {
      const { default: extractZip } = await import("extract-zip");
      await extractZip(a, o);
    },
  } = options;

  if (!archivePath || !existsSync(archivePath)) return "no_archive";

  const sentinel = snapshotSentinelPath(userSkillsDir);
  if (existsSync(sentinel)) return "skipped_sentinel";

  // 目标目录已存在且含非哨兵内容 → 用户手动放了自己的 skill，不覆盖。
  let existing: string[] = [];
  try {
    existing = readdirSync(userSkillsDir).filter((name) => name !== SNAPSHOT_SENTINEL);
  } catch {
    // 目录不存在 → 走首装
  }
  if (existing.length > 0) {
    try {
      writeFileSync(sentinel, new Date().toISOString());
    } catch {
      /* 哨兵写失败无碍：下次启动重查 */
    }
    return "skipped_existing";
  }

  let staging: string | undefined;
  try {
    mkdirSync(path.dirname(userSkillsDir), { recursive: true });
    staging = mkdtempSync(path.join(path.dirname(userSkillsDir), `.${path.basename(userSkillsDir)}-snapshot-`));
    await extract(archivePath, { dir: staging });
    // 哨兵随完整目录一起提交；异常或崩溃残留不会被下一次启动误认作用户内容。
    writeFileSync(snapshotSentinelPath(staging), new Date().toISOString());
    // 只允许删除空目标；解压期间出现的用户文件必须令提交失败，不能递归清理。
    if (existsSync(userSkillsDir)) rmdirSync(userSkillsDir);
    renameSync(staging, userSkillsDir);
    staging = undefined;
    logger.info(LogTag.Skills, `已安装第三方 skills 快照 -> ${userSkillsDir} (${path.basename(archivePath)})`);
    return "installed";
  } catch (err) {
    logger.warn(LogTag.Skills, `第三方 skills 快照安装失败（下次启动重试）:`, err instanceof Error ? err.message : err);
    return "failed";
  } finally {
    if (staging) {
      try { rmSync(staging, { recursive: true, force: true }); }
      catch { /* 只清理本轮暂存；残留在用户技能目录之外，不影响下次重试。 */ }
    }
  }
}
