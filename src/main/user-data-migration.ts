/**
 * 旧 userData 目录 → 新目录（Cyrene）的一次性数据迁移。
 *
 * 背景：历史上 userData 目录名由 package.json 的 name 字段决定（live2d-cyrene），
 * 开发版与安装版共用。补充 productName 后目录统一为 Cyrene，老用户升级时需要
 * 把旧目录数据搬过来。调用时机必须满足两点：
 *   1. 单实例锁获取成功之后（避免两个实例并发搬运）；
 *   2. 任何读取 userData 的代码之前（首个读取点是 GPU 开关里的 loadGeneralSettings）。
 *
 * 安全策略：只做重命名/复制，绝不主动删除旧目录里有内容的东西；
 * 任一条目失败就留在旧目录，下次启动或用 scripts/migrate-user-data.ps1 重试。
 */

import * as fs from "fs";
import * as path from "path";

/** 历史目录名：package.json 的 name 字段 */
const LEGACY_USER_DATA_DIR_NAME = "live2d-cyrene";

/** 运行时文件：新目录里是刚生成的有效状态，旧目录里的是陈旧垃圾。
 *  迁移时保留新目录版本，删除旧目录版本（进程已退出，必然陈旧）。 */
const RUNTIME_FILE_NAMES = new Set(["lockfile", "SingletonLock", "SingletonSocket", "SingletonCookie"]);

/**
 * 迁移完成标记，写在目标目录里。
 *
 * 迁移只该发生一次。若没有这个标记，之后只要旧目录重新出现（例如用户又运行了一次
 * 1.2.x 旧版，它会按旧名字重新建出 live2d-cyrene），下次启动就会再次「旧数据优先」
 * 并入，用旧版的陈旧文件覆盖用户当前的数据。有标记时，重新出现的旧目录不再并入。
 */
const MIGRATION_MARKER_FILE_NAME = ".legacy-user-data-migrated";

/** 合并时被旧目录同名条目覆盖的目标条目移到这里，而不是直接删除，便于找回。 */
const OVERWRITTEN_BACKUP_DIR_NAME = ".legacy-migration-overwritten";

export interface LegacyUserDataMigrationInput {
  /** app.getPath("appData") —— 旧目录的父目录 */
  appDataPath: string;
  /** app.getPath("userData") —— 迁移目标，即应用当前真正使用的数据目录 */
  targetUserDataPath: string;
}

export type LegacyUserDataMigrationStatus =
  | "skipped" // 目录已是目标（同一路径），无需迁移
  | "none" // 旧目录不存在（新用户），无需迁移
  | "renamed" // 目标不存在，旧目录整体原子重命名
  | "merged" // 两者并存，逐项并入且全部成功
  | "partial" // 逐项并入但有失败，残留留在旧目录
  | "failed" // 整体重命名失败，本次放弃（应用将以全新目录启动）
  | "already_migrated"; // 已迁移过（有完成标记），重新出现的旧目录原样保留、不再并入

export interface LegacyUserDataMigrationResult {
  status: LegacyUserDataMigrationStatus;
}

export function migrateLegacyUserData(
  input: LegacyUserDataMigrationInput,
): LegacyUserDataMigrationResult {
  const legacyPath = path.join(input.appDataPath, LEGACY_USER_DATA_DIR_NAME);
  if (path.resolve(legacyPath) === path.resolve(input.targetUserDataPath)) {
    return { status: "skipped" };
  }
  const markerPath = path.join(input.targetUserDataPath, MIGRATION_MARKER_FILE_NAME);
  if (!fs.existsSync(legacyPath)) {
    // 已有安装（含本修复之前完成迁移的用户）：目标在、旧目录不在，说明迁移已完成或从未需要。
    // 补记完成标记，以后旧版即使重新建出旧目录也不会再并入。
    if (fs.existsSync(input.targetUserDataPath) && !fs.existsSync(markerPath)) {
      writeMigrationMarker(markerPath, "none");
    }
    return { status: "none" };
  }
  if (fs.existsSync(markerPath)) {
    console.warn(`[Cyrene] 已完成过用户数据迁移，忽略重新出现的旧目录（原样保留，不并入）: ${legacyPath}`);
    return { status: "already_migrated" };
  }

  // 目标不存在：整体重命名，同卷内原子完成，速度与数据完整性都有保障
  if (!fs.existsSync(input.targetUserDataPath)) {
    try {
      fs.mkdirSync(path.dirname(input.targetUserDataPath), { recursive: true });
      fs.renameSync(legacyPath, input.targetUserDataPath);
      console.log(`[Cyrene] 用户数据目录已整体迁移: ${legacyPath} -> ${input.targetUserDataPath}`);
      writeMigrationMarker(markerPath, "renamed");
      return { status: "renamed" };
    } catch (err) {
      console.error("[Cyrene] 用户数据目录整体迁移失败:", err);
      return { status: "failed" };
    }
  }

  // 两者并存（安装版用户常态：新目录里有安装器写入的文件）。
  // 旧目录是真实用户数据，逐项搬入且旧文件优先覆盖目标同名文件。
  // 被覆盖的目标条目移到备份目录而不是删除：首次迁移失败后应用以全新目录启动，
  // 用户在此期间产生的数据会在下次重试时被覆盖，留一份才能找回。
  const backupRoot = path.join(
    input.targetUserDataPath,
    OVERWRITTEN_BACKUP_DIR_NAME,
    new Date().toISOString().replace(/[:.]/g, "-"),
  );
  let failures = 0;
  for (const entry of fs.readdirSync(legacyPath)) {
    const from = path.join(legacyPath, entry);
    if (RUNTIME_FILE_NAMES.has(entry)) {
      // 陈旧的运行时文件直接丢弃，保住目标目录里刚生成的版本
      try {
        fs.rmSync(from, { recursive: true, force: true });
      } catch {
        // 删不掉也无碍，留在旧目录
      }
      continue;
    }
    const to = path.join(input.targetUserDataPath, entry);
    try {
      if (fs.existsSync(to)) moveAside(to, backupRoot, entry);
      fs.renameSync(from, to);
    } catch {
      try {
        // rename 失败（文件被占用等）时退化为复制，旧目录原样保留
        fs.cpSync(from, to, { recursive: true, force: true });
      } catch (err) {
        failures += 1;
        console.warn(`[Cyrene] 迁移条目失败，已保留在旧目录: ${entry}`, err);
      }
    }
  }

  // 全部搬空才移除旧目录；有残留说明还有文件被占用，留给下次重试
  try {
    if (fs.readdirSync(legacyPath).length === 0) {
      fs.rmdirSync(legacyPath);
    }
  } catch {
    // 移除失败不影响使用
  }

  const status = failures === 0 ? "merged" : "partial";
  console.log(`[Cyrene] 用户数据目录合并迁移完成（${status}）: ${legacyPath} -> ${input.targetUserDataPath}`);
  // 部分失败不写标记：残留条目还在旧目录，下次启动需要继续并入
  if (status === "merged") writeMigrationMarker(markerPath, status);
  return { status };
}

/** 把即将被覆盖的目标条目移进备份目录；移不动时退回原先的删除行为，不阻断迁移。 */
function moveAside(target: string, backupRoot: string, entry: string): void {
  try {
    fs.mkdirSync(backupRoot, { recursive: true });
    fs.renameSync(target, path.join(backupRoot, entry));
  } catch {
    fs.rmSync(target, { recursive: true, force: true });
  }
}

/** 尽力写入完成标记；写不进去只记日志，不影响本次启动。 */
function writeMigrationMarker(markerPath: string, status: LegacyUserDataMigrationStatus): void {
  try {
    fs.writeFileSync(markerPath, JSON.stringify({ status, completedAt: new Date().toISOString() }));
  } catch (err) {
    console.warn("[Cyrene] 写入用户数据迁移完成标记失败:", err);
  }
}
