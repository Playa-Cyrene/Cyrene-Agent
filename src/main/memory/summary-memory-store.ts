import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export interface SummaryReadResult {
  content: string;
  truncated: boolean;
}

export function countUnicodeCharacters(text: string): number {
  return Array.from(text).length;
}

function normalizeText(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

function clampCharacters(text: string, maxChars: number): string {
  return Array.from(text).slice(0, maxChars).join("");
}

async function ensureSafeDirectories(root: string, directories: string[]): Promise<string> {
  const absoluteRoot = path.resolve(root);
  await fs.mkdir(absoluteRoot, { recursive: true });
  let current = absoluteRoot;
  for (const segment of directories) {
    current = path.join(current, segment);
    const relative = path.relative(absoluteRoot, current);
    if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
      throw new Error("SUMMARY_MEMORY_PATH_OUTSIDE_ROOT");
    }
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("SUMMARY_MEMORY_UNSAFE_DIRECTORY");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await fs.mkdir(current);
    }
  }
  return current;
}

export async function readSummaryFile(filePath: string, maxChars: number, allowedRoot: string): Promise<SummaryReadResult> {
  const absolutePath = path.resolve(filePath);
  const absoluteRoot = path.resolve(allowedRoot);
  const relative = path.relative(absoluteRoot, absolutePath);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("SUMMARY_MEMORY_PATH_OUTSIDE_ROOT");
  }
  const parentRelative = path.dirname(relative);
  const parentParts = parentRelative === "." ? [] : parentRelative.split(path.sep);
  let parent = absoluteRoot;
  try {
    for (const segment of parentParts) {
      parent = path.join(parent, segment);
      const parentStat = await fs.lstat(parent);
      if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) throw new Error("SUMMARY_MEMORY_UNSAFE_DIRECTORY");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { content: "", truncated: false };
    throw error;
  }
  try {
    const stat = await fs.lstat(absolutePath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("SUMMARY_MEMORY_UNSAFE_FILE");
    const maxBytes = Math.max(4, maxChars * 4 + 16);
    const handle = await fs.open(absolutePath, "r");
    let text: string;
    try {
      const buffer = Buffer.alloc(maxBytes);
      const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
      text = buffer.subarray(0, bytesRead).toString("utf8");
    } finally {
      await handle.close();
    }
    text = normalizeText(text);
    const chars = Array.from(text);
    const truncated = stat.size > maxBytes || chars.length > maxChars;
    return { content: chars.slice(0, maxChars).join(""), truncated };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { content: "", truncated: false };
    throw error;
  }
}

export async function writeSummaryFileAtomic(
  filePath: string,
  content: string,
  maxChars: number,
  allowedRoot: string,
  shouldCommit?: () => boolean | Promise<boolean>,
): Promise<void> {
  const normalized = normalizeText(content);
  if (countUnicodeCharacters(normalized) > maxChars) throw new Error("SUMMARY_MEMORY_TOO_LONG");
  const absoluteRoot = path.resolve(allowedRoot);
  const absolutePath = path.resolve(filePath);
  const relative = path.relative(absoluteRoot, absolutePath);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("SUMMARY_MEMORY_PATH_OUTSIDE_ROOT");
  }
  const parentRelative = path.dirname(relative);
  const parentParts = parentRelative === "." ? [] : parentRelative.split(path.sep);
  const parent = await ensureSafeDirectories(absoluteRoot, parentParts);
  try {
    const existing = await fs.lstat(absolutePath);
    if (existing.isSymbolicLink() || !existing.isFile()) throw new Error("SUMMARY_MEMORY_UNSAFE_FILE");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const tempPath = path.join(parent, `.${path.basename(absolutePath)}.${randomUUID()}.tmp`);
  try {
    await fs.writeFile(tempPath, normalized, { encoding: "utf8", flag: "wx" });
    if (shouldCommit && !(await shouldCommit())) throw new Error("SUMMARY_MEMORY_CANCELLED");
    await fs.rename(tempPath, absolutePath);
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function deleteSummaryFile(filePath: string, allowedRoot: string): Promise<void> {
  const absoluteRoot = path.resolve(allowedRoot);
  const absolutePath = path.resolve(filePath);
  const relative = path.relative(absoluteRoot, absolutePath);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("SUMMARY_MEMORY_PATH_OUTSIDE_ROOT");
  }
  let parent = absoluteRoot;
  const parentRelative = path.dirname(relative);
  try {
    for (const segment of parentRelative === "." ? [] : parentRelative.split(path.sep)) {
      parent = path.join(parent, segment);
      const parentStat = await fs.lstat(parent);
      if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) throw new Error("SUMMARY_MEMORY_UNSAFE_DIRECTORY");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  try {
    const stat = await fs.lstat(absolutePath);
    if (!stat.isFile() || stat.isSymbolicLink()) return;
    await fs.unlink(absolutePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
