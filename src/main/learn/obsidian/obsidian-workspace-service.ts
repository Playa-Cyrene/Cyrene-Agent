/**
 * ObsidianWorkspaceService — Vault 文件 IO、搜索、章节读写的核心服务。
 *
 * 职责：
 * - 文件列举、搜索（文件名/标题/正文）
 * - 读取完整 Markdown 文件
 * - 按标题路径读取章节
 * - 创建/覆盖/追加/替换章节（原子写入 + contentHash 冲突检查）
 * - 路径沙箱与安全验证
 *
 * 不负责：教学策略、Tool Registry 注册、模型调用。
 */

import * as fs from "fs/promises";
import * as fsSync from "fs";
import * as path from "path";
import {
  extractHeadings,
  readSection,
  replaceSection,
  appendToSection,
  contentHash,
  type MarkdownHeading,
  type SectionLocateError,
} from "./obsidian-markdown";

// ── 类型定义 ─────────────────────────────────────────────────

export interface LearnObsidianSettings {
  enabled: boolean;
  vaultPath: string;
}

export interface ObsidianFileInfo {
  path: string;
  name: string;
  size: number;
  modifiedAt: string;
}

export interface ObsidianReadResult {
  path: string;
  content: string;
  contentHash: string;
  headings: MarkdownHeading[];
}

export interface ObsidianSectionResult {
  path: string;
  headingPath: string[];
  headingDepth: number;
  content: string;
  contentHash: string;
}

export interface ObsidianSearchResult {
  path: string;
  name: string;
  matchType: "filename" | "heading" | "body";
  matchText?: string;
  headingPath?: string[];
}

export interface ObsidianWriteResult {
  path: string;
  operation: string;
  newContentHash: string;
  bytesWritten: number;
}

/**
 * 写契约（本进程内部的不变量，不依赖外部文档）：
 * - create 永不覆盖已有文件，目标存在即拒绝（PATH_ALREADY_EXISTS）；
 * - 修改已有文件的四个操作必须携带 expectedContentHash，缺失即拒绝
 *   （CONTENT_HASH_REQUIRED），不匹配即冲突（CONTENT_CONFLICT）。
 * 类型层对 TS 调用方强制；工具入参来自 JSON，运行时由 edit() 二次强制。
 */
export type ObsidianEditRequest =
  | {
      operation: "create";
      path: string;
      content: string;
    }
  | {
      operation: "replace_file";
      path: string;
      content: string;
      expectedContentHash: string;
    }
  | {
      operation: "append";
      path: string;
      content: string;
      expectedContentHash: string;
    }
  | {
      operation: "replace_section";
      path: string;
      headingPath: string[];
      content: string;
      includeChildren?: boolean;
      expectedContentHash: string;
    }
  | {
      operation: "append_to_section";
      path: string;
      headingPath: string[];
      content: string;
      expectedContentHash: string;
    };

export type ObsidianErrorCode =
  | "VAULT_NOT_CONFIGURED"
  | "VAULT_NOT_FOUND"
  | "PATH_OUTSIDE_VAULT"
  | "PATH_NOT_FOUND"
  | "PATH_ALREADY_EXISTS"
  | "FILE_TYPE_NOT_SUPPORTED"
  | "READ_FAILED"
  | "WRITE_FAILED"
  | "CONTENT_CONFLICT"
  | "CONTENT_HASH_REQUIRED"
  | "HEADING_NOT_FOUND"
  | "AMBIGUOUS_HEADING"
  | "MARKDOWN_PARSE_FAILED";

export class ObsidianError extends Error {
  constructor(
    public code: ObsidianErrorCode,
    message: string,
    public details?: unknown,
  ) {
    super(`[${code}] ${message}`);
    this.name = "ObsidianError";
  }
}

// ── 允许的文件类型 ──────────────────────────────────────────

const ALLOWED_EXTENSIONS = new Set([".md", ".markdown", ".mdown", ".mdx"]);

function isAllowedFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return ALLOWED_EXTENSIONS.has(ext);
}

// ── ObsidianWorkspaceService ─────────────────────────────────

export class ObsidianWorkspaceService {
  private settings: LearnObsidianSettings | null = null;

  /**
   * 配置 Vault 设置。调用方在 Learn 会话启动时设置。
   */
  configure(settings: LearnObsidianSettings): void {
    this.settings = settings;
  }

  /**
   * 当前是否已配置且 Vault 路径有效。
   */
  isReady(): boolean {
    if (!this.settings?.enabled || !this.settings?.vaultPath) return false;
    try {
      return fsSync.existsSync(this.settings.vaultPath);
    } catch {
      return false;
    }
  }

  /**
   * 获取 Vault 根路径（已校验）。
   */
  private vaultRoot(): string {
    if (!this.settings?.enabled || !this.settings?.vaultPath) {
      throw new ObsidianError("VAULT_NOT_CONFIGURED", "Obsidian Vault 未配置");
    }
    if (!fsSync.existsSync(this.settings.vaultPath)) {
      throw new ObsidianError("VAULT_NOT_FOUND", `Vault 路径不存在: ${this.settings.vaultPath}`);
    }
    return path.resolve(this.settings.vaultPath);
  }

  // ── 路径安全 ─────────────────────────────────────────────

  /**
   * 将 Vault 相对路径解析为绝对路径，并验证安全。
   */
  private resolveSafe(relativePath: string): string {
    const root = this.vaultRoot();

    // 拒绝绝对路径
    if (path.isAbsolute(relativePath)) {
      throw new ObsidianError(
        "PATH_OUTSIDE_VAULT",
        `不接受绝对路径: ${relativePath}。请使用 Vault 内的相对路径。`,
      );
    }

    // 拒绝 .. 逃逸
    const normalized = path.normalize(relativePath);
    if (normalized.startsWith("..") || normalized.includes(".." + path.sep)) {
      throw new ObsidianError(
        "PATH_OUTSIDE_VAULT",
        `路径试图跳出 Vault: ${relativePath}`,
      );
    }

    const resolved = path.resolve(root, normalized);

    // 解析后必须仍在 Vault 内
    if (!resolved.startsWith(root + path.sep) && resolved !== root) {
      throw new ObsidianError(
        "PATH_OUTSIDE_VAULT",
        `解析后路径不在 Vault 内: ${resolved}`,
      );
    }

    // 检查是否为符号链接跳出
    try {
      const real = fsSync.realpathSync(resolved);
      if (!real.startsWith(fsSync.realpathSync(root) + path.sep) && real !== fsSync.realpathSync(root)) {
        throw new ObsidianError(
          "PATH_OUTSIDE_VAULT",
          `路径通过符号链接跳出 Vault: ${resolved}`,
        );
      }
    } catch (err) {
      // 文件不存在时不检查 realpath（后续操作会报错）
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }

    // 禁止读写应用内部数据目录：.obsidian/ 由 Obsidian 维护，
    // .cyrene/ 由同进程外部的 Cyrene Notes 维护。
    const protectedDirs = [".obsidian", ".cyrene"];
    for (const dir of protectedDirs) {
      if (
        normalized === dir ||
        normalized.startsWith(dir + "/") ||
        normalized.startsWith(dir + path.sep) ||
        normalized.includes(path.sep + dir + path.sep)
      ) {
        throw new ObsidianError(
          "PATH_OUTSIDE_VAULT",
          `禁止操作 ${dir}/ 目录: ${relativePath}`,
        );
      }
    }

    return resolved;
  }

  /**
   * 验证路径解析安全后，额外检查是否为普通文件（防止通过特殊文件逃逸）。
   */
  private resolveSafeFile(relativePath: string): string {
    const resolved = this.resolveSafe(relativePath);

    // 只处理允许的文件类型
    if (!isAllowedFile(resolved)) {
      throw new ObsidianError(
        "FILE_TYPE_NOT_SUPPORTED",
        `不支持的文件类型: ${path.extname(resolved)}。仅支持 .md / .markdown / .mdx。`,
      );
    }

    return resolved;
  }

  // ── 文件操作 ─────────────────────────────────────────────

  /**
   * 列出 Vault 内的 Markdown 文件。
   */
  async listFiles(input?: {
    relativeDir?: string;
    recursive?: boolean;
  }): Promise<ObsidianFileInfo[]> {
    const root = this.vaultRoot();
    const relativeDir = input?.relativeDir ?? "";
    const recursive = input?.recursive ?? true;

    const targetDir = relativeDir
      ? this.resolveSafe(relativeDir)
      : root;

    const results: ObsidianFileInfo[] = [];

    async function walk(dir: string) {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        // 跳过应用内部数据目录（listFiles 对外只暴露笔记扩展名文件）
        if (entry.isDirectory() && (entry.name === ".obsidian" || entry.name === ".cyrene")) continue;

        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (recursive) await walk(fullPath);
        } else if (entry.isFile() && isAllowedFile(entry.name)) {
          const stat = await fs.stat(fullPath);
          results.push({
            path: path.relative(root, fullPath).replace(/\\/g, "/"),
            name: entry.name,
            size: stat.size,
            modifiedAt: stat.mtime.toISOString(),
          });
        }
      }
    }

    await walk(targetDir);
    return results.sort((a, b) => a.path.localeCompare(b.path));
  }

  /**
   * 搜索文件名、标题和正文。
   */
  async search(input: {
    query: string;
    relativeDir?: string;
    limit?: number;
  }): Promise<ObsidianSearchResult[]> {
    const allFiles = await this.listFiles({
      relativeDir: input.relativeDir,
      recursive: true,
    });

    const query = input.query.toLowerCase();
    const limit = input.limit ?? 20;
    const results: ObsidianSearchResult[] = [];

    for (const file of allFiles) {
      if (results.length >= limit) break;

      // 文件名匹配
      if (file.name.toLowerCase().includes(query)) {
        results.push({
          path: file.path,
          name: file.name,
          matchType: "filename",
        });
        continue;
      }

      // 标题和正文匹配
      try {
        const readResult = await this.readFile({ path: file.path });
        const content = readResult.content;

        // 标题匹配
        for (const heading of readResult.headings) {
          if (results.length >= limit) break;
          if (heading.text.toLowerCase().includes(query)) {
            results.push({
              path: file.path,
              name: file.name,
              matchType: "heading",
              matchText: heading.text,
              headingPath: heading.path,
            });
          }
        }

        // 正文匹配（简单关键词匹配，不包含标题行）
        if (results.length < limit && content.toLowerCase().includes(query)) {
          // 检查是否已经有文件名或标题匹配记录了
          const alreadyListed = results.some((r) => r.path === file.path);
          if (!alreadyListed) {
            results.push({
              path: file.path,
              name: file.name,
              matchType: "body",
            });
          }
        }
      } catch {
        // 搜索时文件读取失败跳过
        continue;
      }
    }

    return results.slice(0, limit);
  }

  /**
   * 读取完整 Markdown 文件。
   */
  async readFile(input: { path: string }): Promise<ObsidianReadResult> {
    const resolved = this.resolveSafeFile(input.path);

    let content: string;
    try {
      content = await fs.readFile(resolved, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw new ObsidianError("PATH_NOT_FOUND", `文件不存在: ${input.path}`);
      }
      throw new ObsidianError("READ_FAILED", `读取文件失败: ${input.path}`, err);
    }

    const hash = contentHash(content);
    const headings = extractHeadings(content);

    return {
      path: input.path,
      content,
      contentHash: hash,
      headings,
    };
  }

  /**
   * 按标题路径读取章节。
   */
  async readSection(input: {
    path: string;
    headingPath: string[];
    includeChildren?: boolean;
  }): Promise<ObsidianSectionResult> {
    const readResult = await this.readFile({ path: input.path });
    const result = readSection(
      readResult.content,
      input.headingPath,
      input.includeChildren ?? false,
    );

    if (typeof result === "object" && "kind" in result) {
      if (result.kind === "NOT_FOUND") {
        throw new ObsidianError(
          "HEADING_NOT_FOUND",
          `标题路径未找到: ${input.headingPath.join(" > ")}，文件: ${input.path}`,
        );
      }
      if (result.kind === "AMBIGUOUS") {
        throw new ObsidianError(
          "AMBIGUOUS_HEADING",
          `标题路径不唯一: ${input.headingPath.join(" > ")}，文件: ${input.path}`,
          result.matches?.map((m) => m.path.join(" > ")),
        );
      }
    }

    // 获取章对应的 heading 深度
    const headings = readResult.headings;
    const matchedHeading = headings.find(
      (h) =>
        h.path.length === input.headingPath.length &&
        input.headingPath.every((part, i) => h.path[i] === part),
    );

    return {
      path: input.path,
      headingPath: input.headingPath,
      headingDepth: matchedHeading?.depth ?? input.headingPath.length,
      content: result as string,
      contentHash: contentHash(result as string),
    };
  }

  /**
   * 编辑操作：创建/覆盖/追加/替换章节。
   */
  async edit(input: ObsidianEditRequest): Promise<ObsidianWriteResult> {
    if (input.operation !== "create" && !input.expectedContentHash) {
      // 工具入参来自 JSON，会绕过 TS 类型；运行时再卡一道，确保模型不会无锁写。
      throw new ObsidianError(
        "CONTENT_HASH_REQUIRED",
        `修改已有文件必须携带 expectedContentHash（先 read_file 获取），操作: ${input.operation}，文件: ${input.path}`,
      );
    }

    switch (input.operation) {
      case "create": {
        const resolved = this.resolveSafeFile(input.path);

        // create 永不覆盖：目标已存在一律拒绝（要修改已有文件必须走 replace_file + hash）
        if (fsSync.existsSync(resolved)) {
          throw new ObsidianError(
            "PATH_ALREADY_EXISTS",
            `文件已存在，create 不覆盖: ${input.path}。如需修改请先 read_file 再用对应编辑操作。`,
          );
        }

        await this.atomicWrite(resolved, input.content);
        return {
          path: input.path,
          operation: "create",
          newContentHash: contentHash(input.content),
          bytesWritten: Buffer.byteLength(input.content, "utf8"),
        };
      }

      case "replace_file": {
        const resolved = this.resolveSafeFile(input.path);

        await this.checkContentHash(resolved, input.expectedContentHash, input.path);

        await this.atomicWrite(resolved, input.content);
        return {
          path: input.path,
          operation: "replace_file",
          newContentHash: contentHash(input.content),
          bytesWritten: Buffer.byteLength(input.content, "utf8"),
        };
      }

      case "append": {
        const resolved = this.resolveSafeFile(input.path);

        await this.checkContentHash(resolved, input.expectedContentHash, input.path);

        const existing = await fs.readFile(resolved, "utf8");
        const separator = existing.endsWith("\n") ? "" : "\n";
        const newContent = existing + separator + input.content.trimEnd() + "\n";

        await this.atomicWrite(resolved, newContent);
        return {
          path: input.path,
          operation: "append",
          newContentHash: contentHash(newContent),
          bytesWritten: Buffer.byteLength(newContent, "utf8"),
        };
      }

      case "replace_section": {
        const resolved = this.resolveSafeFile(input.path);

        await this.checkContentHash(resolved, input.expectedContentHash, input.path);

        const existing = await fs.readFile(resolved, "utf8");
        const result = replaceSection(
          existing,
          input.headingPath,
          input.content,
          input.includeChildren ?? false,
        );

        if (typeof result === "object" && "kind" in result) {
          if (result.kind === "NOT_FOUND") {
            throw new ObsidianError(
              "HEADING_NOT_FOUND",
              `标题路径未找到: ${input.headingPath.join(" > ")}，文件: ${input.path}`,
            );
          }
          throw new ObsidianError(
            "AMBIGUOUS_HEADING",
            `标题路径不唯一: ${input.headingPath.join(" > ")}，文件: ${input.path}`,
          );
        }

        await this.atomicWrite(resolved, result as string);
        return {
          path: input.path,
          operation: "replace_section",
          newContentHash: contentHash(result as string),
          bytesWritten: Buffer.byteLength(result as string, "utf8"),
        };
      }

      case "append_to_section": {
        const resolved = this.resolveSafeFile(input.path);

        await this.checkContentHash(resolved, input.expectedContentHash, input.path);

        const existing = await fs.readFile(resolved, "utf8");
        const result = appendToSection(existing, input.headingPath, input.content);

        if (typeof result === "object" && "kind" in result) {
          if (result.kind === "NOT_FOUND") {
            throw new ObsidianError(
              "HEADING_NOT_FOUND",
              `标题路径未找到: ${input.headingPath.join(" > ")}，文件: ${input.path}`,
            );
          }
          throw new ObsidianError(
            "AMBIGUOUS_HEADING",
            `标题路径不唯一: ${input.headingPath.join(" > ")}，文件: ${input.path}`,
          );
        }

        await this.atomicWrite(resolved, result as string);
        return {
          path: input.path,
          operation: "append_to_section",
          newContentHash: contentHash(result as string),
          bytesWritten: Buffer.byteLength(result as string, "utf8"),
        };
      }
    }
  }

  // ── 内部辅助 ─────────────────────────────────────────────

  /**
   * 原子写入：先写临时文件，再 rename。
   */
  private async atomicWrite(filePath: string, content: string): Promise<void> {
    const tmpPath = filePath + ".cyrene-tmp-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);

    try {
      // 确保目录存在
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(tmpPath, content, "utf8");
      await fs.rename(tmpPath, filePath);
    } catch (err) {
      // 清理临时文件
      try { await fs.unlink(tmpPath); } catch { /* ignore */ }
      throw new ObsidianError("WRITE_FAILED", `写入文件失败: ${filePath}`, err);
    }
  }

  /**
   * contentHash 冲突检查。
   */
  private async checkContentHash(
    resolved: string,
    expected: string,
    displayPath: string,
  ): Promise<void> {
    let current: string;
    try {
      current = await fs.readFile(resolved, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw new ObsidianError("PATH_NOT_FOUND", `文件不存在: ${displayPath}`);
      }
      throw err;
    }

    const currentHash = contentHash(current);
    if (currentHash !== expected) {
      throw new ObsidianError(
        "CONTENT_CONFLICT",
        `文件 ${displayPath} 已被外部修改，请重新读取后再编辑。`,
        { expected, current: currentHash },
      );
    }
  }
}

// ── 全局单例 ─────────────────────────────────────────────────

export const obsidianWorkspace = new ObsidianWorkspaceService();
