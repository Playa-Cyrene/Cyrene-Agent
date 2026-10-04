// ── 工具：open_file（用系统默认程序打开单个文件）────────────────────
//
// 上游已有渲染层的 shellFile IPC（FileChangeCard 右键、正文文件链接在用），
// 但那是 UI 触发；模型侧没有对应工具。open_file 把「用默认程序打开一个本地文件」
// 暴露成 agent 工具：用户说「帮我打开这个文件」时调用。
//
// 只读红线：只调用 shell.openPath 交给系统默认程序，绝不修改/写入文件内容。
// openPath 成功返回空串，失败返回非空错误描述。
// electron 采用顶层命名导入（与仓库其他工具一致），测试用 vi.mock("electron") 拦截真实二进制。

import * as fs from "fs";
import * as path from "path";
import { shell } from "electron";
import type { ToolDefinition } from "../registry/tool-registry";

const LOG_PREFIX = "[BuiltinTools]";

function ensureAbsolute(p: string): string | null {
  if (!p || !path.isAbsolute(p)) return null;
  return path.normalize(p);
}

async function executeOpenFile(args: Record<string, unknown>): Promise<string> {
  const raw = String(args.path ?? "").trim();
  const filePath = ensureAbsolute(raw);
  if (!filePath) {
    return JSON.stringify({ success: false, errorCode: "INVALID_PATH", error: "path 必须是绝对路径: " + raw, retryable: false });
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return JSON.stringify({ success: false, errorCode: "FILE_NOT_FOUND", error: "文件不存在或无法访问: " + filePath, retryable: false });
  }
  if (!stat.isFile()) {
    return JSON.stringify({ success: false, errorCode: "NOT_A_FILE", error: "不是普通文件: " + filePath, retryable: false });
  }

  console.log(LOG_PREFIX, "open_file:", filePath);
  try {
    const error = await shell.openPath(filePath);
    if (error) {
      return JSON.stringify({ success: false, errorCode: "OPEN_FAILED", error, path: filePath, retryable: false });
    }
    return JSON.stringify({ success: true, path: filePath, opened: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return JSON.stringify({ success: false, errorCode: "OPEN_FAILED", error: msg, path: filePath, retryable: false });
  }
}

export const openFileTool: ToolDefinition = {
  id: "open_file",
  name: "打开文件",
  description:
    "用系统默认程序打开一个本地文件（相当于双击）。只在用户明确要「打开/看看这个文件」时调用；" +
    "读文本/Word/Excel 的内容用 read_file，读图片用 read_image，本工具只是交给系统程序。\n\n" +
    "只读：不会修改文件内容。\n" +
    "参数：path (必填，文件绝对路径)。",
  enabled: true,
  risk: "fs-read",
  modes: ["chat", "learn", "code", "work"],
  chatBuiltin: true,
  effectKind: "read" as const,
  isConcurrencySafe: () => true,
  verificationPolicy: "none" as const,
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "要打开的文件绝对路径，例如 'C:\\\\Users\\\\me\\\\report.docx'" },
    },
    required: ["path"],
  },
  execute: executeOpenFile,
};
