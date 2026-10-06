import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { WikiScope } from "./wiki-types";

const PAGE_ID_PATTERN = /^(?:global\/[a-f0-9]{32}|global\/self|workspace\/[a-f0-9]{32}\/[a-f0-9]{32})$/;

export function wikiHash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 32);
}

/** Resolve a workspace root before hashing so aliases of the same directory share a scope. */
export function workspaceScope(workspaceRoot: string): Extract<WikiScope, { kind: "workspace" }> {
  if (!path.isAbsolute(workspaceRoot)) throw new Error("WIKI_INVALID_WORKSPACE_ROOT");
  const resolved = path.resolve(workspaceRoot);
  return { kind: "workspace", workspaceId: wikiHash(process.platform === "win32" ? resolved.toLowerCase() : resolved) };
}

export function wikiRootForUserData(userDataRoot: string): string {
  if (!path.isAbsolute(userDataRoot)) throw new Error("WIKI_INVALID_USER_DATA_ROOT");
  return path.join(path.resolve(userDataRoot), "memory", "wiki");
}

export function pageIdFor(subject: string, scope: WikiScope): string {
  const normalized = subject.normalize("NFKC").trim().toLocaleLowerCase();
  if (!normalized || normalized.length > 160) throw new Error("WIKI_INVALID_SUBJECT");
  if (scope.kind === "global") {
    if (["我", "用户", "用户本人", "自己", "self"].includes(normalized)) return "global/self";
    return `global/${wikiHash(normalized)}`;
  }
  if (!/^[a-f0-9]{32}$/.test(scope.workspaceId)) throw new Error("WIKI_INVALID_WORKSPACE_ID");
  return `workspace/${scope.workspaceId}/${wikiHash(normalized)}`;
}

export function isValidPageId(pageId: string): boolean {
  return PAGE_ID_PATTERN.test(pageId);
}

export function pageRelativePath(pageId: string): string {
  if (!isValidPageId(pageId)) throw new Error("WIKI_INVALID_PAGE_ID");
  if (pageId === "global/self") return path.join("pages", "self.md");
  const [kind, first, second] = pageId.split("/");
  return kind === "global"
    ? path.join("pages", "global", `${first}.md`)
    : path.join("pages", "projects", first, `${second}.md`);
}

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

export function safeWikiPath(root: string, relative: string): string {
  if (path.isAbsolute(relative)) throw new Error("WIKI_PATH_OUTSIDE_ROOT");
  const target = path.resolve(root, relative);
  if (!inside(path.resolve(root), target)) throw new Error("WIKI_PATH_OUTSIDE_ROOT");
  return target;
}

async function assertSafeDirectory(directory: string, create: boolean): Promise<void> {
  try {
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("WIKI_UNSAFE_DIRECTORY");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !create) throw error;
    await fs.mkdir(directory);
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("WIKI_UNSAFE_DIRECTORY");
  }
}

/** Check each wiki-owned path segment before access; never follow a symlink inside the wiki. */
export async function ensureWikiDirectories(root: string, relativeDirectory = "", create = true): Promise<string> {
  const absoluteRoot = path.resolve(root);
  const base = path.dirname(path.dirname(absoluteRoot));
  if (!inside(base, absoluteRoot)) throw new Error("WIKI_PATH_OUTSIDE_ROOT");
  await assertSafeDirectory(base, create);
  const segments = path.relative(base, absoluteRoot).split(path.sep).concat(
    relativeDirectory === "" ? [] : relativeDirectory.split(/[\\/]/),
  );
  let current = base;
  for (const segment of segments) {
    if (!segment || segment === "." || segment === "..") throw new Error("WIKI_PATH_OUTSIDE_ROOT");
    current = path.join(current, segment);
    await assertSafeDirectory(current, create);
  }
  return current;
}

export async function assertSafeWikiFile(root: string, relative: string, allowMissing = true): Promise<string> {
  const target = safeWikiPath(root, relative);
  const parentRelative = path.dirname(path.relative(path.resolve(root), target));
  await ensureWikiDirectories(root, parentRelative === "." ? "" : parentRelative, false);
  try {
    const stat = await fs.lstat(target);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("WIKI_UNSAFE_FILE");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !allowMissing) throw error;
  }
  return target;
}

export async function writeWikiFileAtomic(root: string, relative: string, content: string, shouldCommit?: () => boolean | Promise<boolean>): Promise<void> {
  const target = safeWikiPath(root, relative);
  const parentRelative = path.dirname(path.relative(path.resolve(root), target));
  const parent = await ensureWikiDirectories(root, parentRelative === "." ? "" : parentRelative);
  try {
    const stat = await fs.lstat(target);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("WIKI_UNSAFE_FILE");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temp = path.join(parent, `.${path.basename(target)}.${randomUUID()}.tmp`);
  try {
    const handle = await fs.open(temp, "wx", 0o600);
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (shouldCommit && !(await shouldCommit())) throw new Error("WIKI_WRITE_CANCELLED");
    await fs.rename(temp, target);
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function readWikiFile(root: string, relative: string): Promise<string | null> {
  try {
    const file = await assertSafeWikiFile(root, relative, false);
    return await fs.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
