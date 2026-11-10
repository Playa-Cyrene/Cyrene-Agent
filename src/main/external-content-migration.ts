import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * 升级暂存内容只与构建时的原厂基准比较。安装目录允许用户修改，不能在启动时
 * 重新把这些修改登记成原厂内容。旧版无来源标记的缓存不用于丢弃用户文件。
 */

const STAGING_DIR_NAME = ".Cyrene.content-preserve";
const MANIFEST_FILE = "content-manifest.json";

interface ContentManifest {
  formatVersion: 2;
  source: "build";
  prompts: Record<string, string>;
  skills: Record<string, string>;
}

export interface StagedContentMigrationInput {
  isPackaged: boolean;
  installRoot: string;
  promptDirectories: string[];
  userSkillDirectories: string[];
  /** 测试可替换；生产文件由 build:main 写入 app.asar 内的本模块同目录。 */
  shippedManifestPath?: string;
}

/** 迁移失败保留暂存目录与旧基准，供下次启动重试。 */
export function migrateStagedExternalContent(input: StagedContentMigrationInput): void {
  if (!input.isPackaged || !input.promptDirectories[0] || !input.userSkillDirectories[0]) return;
  try {
    const stagingDir = path.join(input.installRoot, "..", STAGING_DIR_NAME);
    const shipped = readManifestFile(input.shippedManifestPath ?? path.join(__dirname, "shipped-external-content-manifest.json"));
    if (fs.existsSync(stagingDir)) {
      mergeStaging(stagingDir, input, shipped);
      // 清理失败时暂存仍属于旧版本，必须保留旧基准供下次启动重试。
      fs.rmSync(stagingDir, { recursive: true, force: true });
    }
    writeManifest(input, shipped);
  } catch {
    // 不把迁移失败误报为完成；源文件保留，重试时不会覆盖已存在的用户内容。
  }
}

function mergeStaging(stagingDir: string, input: StagedContentMigrationInput, shipped: ContentManifest | null): void {
  const previous = readManifestFile(manifestPath(input));
  const backupRoot = path.join(path.dirname(input.promptDirectories[0]), "content-upgrade-backups");
  mergeTree(path.join(stagingDir, "prompts"), input.promptDirectories[0], previous?.prompts, shipped?.prompts, path.join(backupRoot, "prompts"));
  mergeTree(path.join(stagingDir, "skills"), input.userSkillDirectories[0], previous?.skills, shipped?.skills, path.join(backupRoot, "skills"));
}

function mergeTree(
  stagedRoot: string,
  userRoot: string,
  previousHashes: Record<string, string> | undefined,
  shippedHashes: Record<string, string> | undefined,
  backupRoot: string,
): void {
  if (!fs.existsSync(stagedRoot)) return;
  for (const relativePath of walkFiles(stagedRoot)) {
    const stagedFile = path.join(stagedRoot, relativePath);
    const stagedHash = sha1File(stagedFile);
    if (previousHashes?.[relativePath] === stagedHash || shippedHashes?.[relativePath] === stagedHash) continue;

    const targetFile = path.join(userRoot, relativePath);
    if (fs.existsSync(targetFile)) {
      if (fs.statSync(targetFile).isFile() && sha1File(targetFile) === stagedHash) continue;
      // 用户区已有不同内容时不覆写，也不丢弃暂存版本；按内容寻址使重试幂等。
      const backupFile = path.join(backupRoot, `${relativePath}.${stagedHash}.bak`);
      if (fs.existsSync(backupFile)) {
        if (sha1File(backupFile) !== stagedHash) throw new Error("Content migration backup conflicts with staged content");
      } else {
        fs.mkdirSync(path.dirname(backupFile), { recursive: true });
        fs.copyFileSync(stagedFile, backupFile, fs.constants.COPYFILE_EXCL);
      }
      continue;
    }
    fs.mkdirSync(path.dirname(targetFile), { recursive: true });
    fs.copyFileSync(stagedFile, targetFile, fs.constants.COPYFILE_EXCL);
  }
}

/** userData 下 manifest 的位置（与用户内容同目录）。 */
function manifestPath(input: StagedContentMigrationInput): string {
  return path.join(path.dirname(input.promptDirectories[0]), MANIFEST_FILE);
}

function readManifestFile(file: string): ContentManifest | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<ContentManifest>;
    const isHashMap = (value: unknown): value is Record<string, string> =>
      Boolean(value) && typeof value === "object" && !Array.isArray(value) &&
      Object.values(value as Record<string, unknown>).every((hash) => typeof hash === "string" && /^[0-9a-f]{40}$/.test(hash));
    // formatVersion=2 只由构建清单产生；旧缓存可能已记录用户改动，不能当原厂基准。
    if (parsed?.formatVersion !== 2 || parsed.source !== "build" || !isHashMap(parsed.prompts) || !isHashMap(parsed.skills)) return null;
    return { formatVersion: 2, source: "build", prompts: parsed.prompts, skills: parsed.skills };
  } catch {
    return null;
  }
}

function writeManifest(input: StagedContentMigrationInput, shipped: ContentManifest | null): void {
  const file = manifestPath(input);
  if (!shipped) {
    // 缺失/损坏的构建清单不能退回扫描可修改的安装目录，也不能继续沿用过期缓存。
    fs.rmSync(file, { force: true });
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(shipped), "utf8");
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function walkFiles(root: string): string[] {
  const files: string[] = [];
  const queue: string[] = [root];
  while (queue.length) {
    const dir = queue.shift()!;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) queue.push(full);
      else if (entry.isFile()) files.push(path.relative(root, full).split(path.sep).join("/"));
    }
  }
  return files;
}

function sha1File(file: string): string {
  return crypto.createHash("sha1").update(fs.readFileSync(file)).digest("hex");
}
