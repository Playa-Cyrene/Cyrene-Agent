// Built-in MCP auto-sync functions.
// Extracted from src/main/index.ts so vitest can import them without
// pulling in the whole Electron entry-point.

import * as path from "path";
import { addMcpServer, removeMcpServer, listMcpServerConfigs } from "./orchestrator/mcp-manager";
import type { McpServerConfig } from "./orchestrator/mcp-adapter";

const LOG_PREFIX = "[Cyrene]";

export const PLAYWRIGHT_MCP_ID = "playwright-mcp";
export const FILESYSTEM_MCP_ID = "filesystem-mcp";

/**
 * 已下架的内置 MCP server id 列表 —— 启动时从 mcp-servers.json 中清理。
 * 仅当 id 在此名单内才会被清理，不会误删用户自定义 MCP。
 */
export const REMOVED_BUILTIN_MCP_IDS: readonly string[] = ["firecrawl-hosted"];

/**
 * 解析打包内 @playwright/mcp/cli.js 的绝对路径。
 *
 * - 包的 exports 字段不暴露 ./cli.js，借 ./package.json 定位包根再拼 cli.js
 * - 打包后包体被 electron-builder asarUnpack 到 app.asar.unpacked，
 *   require.resolve 返回的是 asar 虚拟路径；ELECTRON_RUN_AS_NODE 模式下
 *   的 Node 读不了 asar，需替换为真实磁盘路径
 */
export function resolvePlaywrightMcpCliPath(): string {
  const pkgJsonPath = require.resolve("@playwright/mcp/package.json");
  const cliPath = path.join(path.dirname(pkgJsonPath), "cli.js");
  return cliPath.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
}

/**
 * 期望的 Playwright MCP server 配置。
 *
 * 运行时分发方式（不依赖用户机器的 Node.js / npx）：
 *   process.execPath（dev: electron.exe / 打包: Cyrene.exe）
 *   + ELECTRON_RUN_AS_NODE=1（Electron 以纯 Node 模式运行 cli.js）
 *   + --browser msedge（用系统自带 Edge，无需下载 Chromium）
 * 版本随 package.json 精确锁定（@playwright/mcp 无 ^ 漂移）。
 */
export function buildPlaywrightMcpConfig(): McpServerConfig {
  return {
    id: PLAYWRIGHT_MCP_ID,
    name: "Playwright 浏览器",
    transport: "stdio",
    command: process.execPath,
    args: [resolvePlaywrightMcpCliPath(), "--isolated", "--headless", "--browser", "msedge"],
    env: { ELECTRON_RUN_AS_NODE: "1" },
  };
}

/**
 * 解析打包内 @modelcontextprotocol/server-filesystem 的入口绝对路径。
 * 与 Playwright MCP 同理：asar 虚拟路径在 ELECTRON_RUN_AS_NODE 模式下不可读，
 * 需替换为 electron-builder asarUnpack 解出的真实磁盘路径。
 */
export function resolveFilesystemMcpCliPath(): string {
  const pkgJsonPath = require.resolve("@modelcontextprotocol/server-filesystem/package.json");
  return path.join(path.dirname(pkgJsonPath), "dist", "index.js")
    .replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
}

/**
 * 期望的 Filesystem MCP server 配置。
 * 与 Playwright 相同的分发方式（不依赖用户机器的 Node.js / npx）。
 * allowedDir 由调用方传入（默认下载目录），保持本模块不依赖 electron 以便 vitest 测试。
 * 版本随 package.json 精确锁定（无 ^ 漂移）。
 */
export function buildFilesystemMcpConfig(allowedDir: string): McpServerConfig {
  return {
    id: FILESYSTEM_MCP_ID,
    name: "文件系统",
    transport: "stdio",
    command: process.execPath,
    args: [resolveFilesystemMcpCliPath(), allowedDir],
    env: { ELECTRON_RUN_AS_NODE: "1" },
  };
}

function sameConfig(a: McpServerConfig | undefined, b: McpServerConfig): boolean {
  if (!a) return false;
  return a.command === b.command
    && JSON.stringify(a.args ?? []) === JSON.stringify(b.args ?? [])
    && JSON.stringify(a.env ?? {}) === JSON.stringify(b.env ?? {});
}

/**
 * Sync the Playwright MCP server.
 * Default OFF: opt-in via settings.playwrightMcpEnabled.
 *
 * 以 mcp-servers.json 持久化配置为事实源（而非运行时连接态）：
 * - enabled 且无配置 → 注册
 * - enabled 且配置过期（旧 npx 方案 / 安装路径迁移）→ 自动重建
 * - disabled 且有配置 → 移除
 */
export async function syncPlaywrightMcp(settings: {
  playwrightMcpEnabled: boolean;
}): Promise<void> {
  const stored = listMcpServerConfigs().find(s => s.id === PLAYWRIGHT_MCP_ID);

  if (settings.playwrightMcpEnabled) {
    const expected = buildPlaywrightMcpConfig();
    const stale = !!stored && !sameConfig(stored, expected);

    if (stale) {
      console.log(LOG_PREFIX, "Playwright MCP 配置过期，自动迁移:", stored?.command, "→", expected.command);
      try {
        await removeMcpServer(PLAYWRIGHT_MCP_ID);
      } catch (err) {
        console.error(LOG_PREFIX, "Playwright MCP 旧配置移除异常:", err);
      }
    }

    if (!stored || stale) {
      console.log(LOG_PREFIX, "注册 Playwright MCP Server...");
      try {
        const result = await addMcpServer(buildPlaywrightMcpConfig());
        if (result.ok) {
          console.log(LOG_PREFIX, "Playwright MCP 注册成功,工具:", result.toolIds?.join(", "));
        } else {
          console.error(LOG_PREFIX, "Playwright MCP 注册失败:", result.error);
        }
      } catch (err) {
        console.error(LOG_PREFIX, "Playwright MCP 注册异常:", err);
      }
    }
  } else if (stored) {
    console.log(LOG_PREFIX, "移除 Playwright MCP Server...");
    try {
      await removeMcpServer(PLAYWRIGHT_MCP_ID);
    } catch (err) {
      console.error(LOG_PREFIX, "Playwright MCP 移除异常:", err);
    }
  }
}

/**
 * Sync the Filesystem MCP server（官方 @modelcontextprotocol/server-filesystem）。
 * Default OFF: opt-in via settings.filesystemMcpEnabled。
 * 逻辑与 syncPlaywrightMcp 一致：以持久化配置为事实源，过期自动重建。
 */
export async function syncFilesystemMcp(settings: {
  filesystemMcpEnabled: boolean;
  allowedDir: string;
}): Promise<void> {
  const stored = listMcpServerConfigs().find(s => s.id === FILESYSTEM_MCP_ID);

  if (settings.filesystemMcpEnabled) {
    const expected = buildFilesystemMcpConfig(settings.allowedDir);
    const stale = !!stored && !sameConfig(stored, expected);

    if (stale) {
      console.log(LOG_PREFIX, "Filesystem MCP 配置过期，自动迁移:", stored?.args?.[1], "→", settings.allowedDir);
      try {
        await removeMcpServer(FILESYSTEM_MCP_ID);
      } catch (err) {
        console.error(LOG_PREFIX, "Filesystem MCP 旧配置移除异常:", err);
      }
    }

    if (!stored || stale) {
      console.log(LOG_PREFIX, "注册 Filesystem MCP Server...");
      try {
        const result = await addMcpServer(expected);
        if (result.ok) {
          console.log(LOG_PREFIX, "Filesystem MCP 注册成功,工具:", result.toolIds?.join(", "));
        } else {
          console.error(LOG_PREFIX, "Filesystem MCP 注册失败:", result.error);
        }
      } catch (err) {
        console.error(LOG_PREFIX, "Filesystem MCP 注册异常:", err);
      }
    }
  } else if (stored) {
    console.log(LOG_PREFIX, "移除 Filesystem MCP Server...");
    try {
      await removeMcpServer(FILESYSTEM_MCP_ID);
    } catch (err) {
      console.error(LOG_PREFIX, "Filesystem MCP 移除异常:", err);
    }
  }
}
