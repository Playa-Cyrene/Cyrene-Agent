// ── 工具：send_file（把本地文件作为附件发回当前渠道会话）───────────────
//
// 这是「出站发文件」缺的那一环：渠道类型 OutgoingPart 的 file part、能力降级
// downgradeToCapability、微信/QQ(NapCat) 适配器发 file 都已就绪，唯独没有任何工具
// 会产生 file part。send_file 补上工具侧，附件随「当前回复」发回消息来源的会话/用户。
//
// 为什么不用 runResult.toolResults 提取：harness 模式（渠道带工具运行都走它）返回的
// toolResults 恒为空数组（harness-adapter.ts）。因此这里按 runId 侧存，bootstrap 在 run
// 收尾后 consumePendingSends(runId) 读回，塞进出站 attachments。对齐仓库既有
// run-review-tracker「按 runId 记账」的先例。
//
// 只默认发回来源会话；不做跨渠道/指定他人（本工具无目标参数）。
// 只读红线：只读取校验文件，绝不修改内容。

import * as fs from "fs";
import * as path from "path";
import type { ToolDefinition } from "../registry/tool-registry";
import type { ToolContext } from "../registry/tool-context";
import type { OutgoingFileAttachment } from "../../../channels/types";

const LOG_PREFIX = "[BuiltinTools]";

const MAX_SINGLE_BYTES = 100 * 1024 * 1024; // 单文件上限 100MB
const MAX_PER_RUN = 10;                       // 每轮最多发 10 个文件
const PENDING_RUNS_CAP = 64;                  // 侧存最多保留 64 个 run，防桌面 run 未消费堆积

const MIME_BY_EXT: Record<string, string> = {
  ".txt": "text/plain", ".md": "text/markdown", ".csv": "text/csv", ".json": "application/json",
  ".pdf": "application/pdf",
  ".doc": "application/msword", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel", ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint", ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".bmp": "image/bmp", ".svg": "image/svg+xml", ".ico": "image/x-icon",
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg", ".m4a": "audio/mp4",
  ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime", ".avi": "video/x-msvideo",
  ".zip": "application/zip", ".rar": "application/vnd.rar", ".7z": "application/x-7z-compressed",
  ".gz": "application/gzip",
};

function guessMime(filePath: string): string | undefined {
  return MIME_BY_EXT[path.extname(filePath).toLowerCase()];
}

// ── runId 侧存 ───────────────────────────────────────────
const pendingSends = new Map<string, OutgoingFileAttachment[]>();

function recordPendingSend(runId: string, att: OutgoingFileAttachment): boolean {
  const existing = pendingSends.get(runId) ?? [];
  if (existing.length >= MAX_PER_RUN) return false;
  existing.push(att);
  pendingSends.set(runId, existing);
  // 侧存上限：超出删最旧（Map 保持插入序）
  while (pendingSends.size > PENDING_RUNS_CAP) {
    const oldest = pendingSends.keys().next();
    if (oldest.done) break;
    pendingSends.delete(oldest.value);
  }
  return true;
}

/** run 收尾后取回并清空该 run 的待发附件（幂等：二次调用返回空）。 */
export function consumePendingSends(runId: string | undefined): OutgoingFileAttachment[] {
  if (!runId) return [];
  const list = pendingSends.get(runId) ?? [];
  pendingSends.delete(runId);
  return list;
}

/** 测试隔离用：清空全部侧存。 */
export function clearPendingSends(): void {
  pendingSends.clear();
}

async function executeSendFile(args: Record<string, unknown>, ctx?: ToolContext): Promise<string> {
  const raw = String(args.path ?? "").trim();
  if (!raw || !path.isAbsolute(raw)) {
    return JSON.stringify({ success: false, errorCode: "INVALID_PATH", error: "path 必须是文件绝对路径: " + raw, retryable: false });
  }
  const filePath = path.normalize(raw);

  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return JSON.stringify({ success: false, errorCode: "FILE_NOT_FOUND", error: "文件不存在或无法访问: " + filePath, retryable: false });
  }
  if (!stat.isFile()) {
    return JSON.stringify({ success: false, errorCode: "NOT_A_FILE", error: "不是普通文件: " + filePath, retryable: false });
  }
  if (stat.size > MAX_SINGLE_BYTES) {
    return JSON.stringify({
      success: false, errorCode: "FILE_TOO_LARGE",
      error: `文件超过 100MB 上限（当前 ${(stat.size / 1024 / 1024).toFixed(1)}MB）`, path: filePath, retryable: false,
    });
  }

  const name = String(args.name ?? "").trim() || path.basename(filePath);
  const mime = guessMime(filePath);

  const runId = ctx?.runId;
  if (!runId) {
    return JSON.stringify({
      success: false,
      errorCode: "NO_CHANNEL",
      reason: "当前会话不支持发文件（仅渠道回复可发）",
      path: filePath, name, mime,
    });
  }

  const ok = recordPendingSend(runId, { filePath, name, mime });
  if (!ok) {
    return JSON.stringify({ success: false, errorCode: "TOO_MANY_FILES", error: `每轮最多发 ${MAX_PER_RUN} 个文件`, path: filePath, retryable: false });
  }

  console.log(LOG_PREFIX, "send_file 记账:", filePath, "run=" + runId);
  return JSON.stringify({ sent: true, pending: true, filePath, name, mime });
}

export const sendFileTool: ToolDefinition = {
  id: "send_file",
  name: "发送文件",
  description:
    "把一个本地文件作为附件，随当前这条回复发回消息来源的会话/用户（微信、QQ 等渠道）。\n\n" +
    "何时用：用户说「把那个文件发给我」「发一份 XX 过来」且消息来自某个渠道。\n" +
    "限制：只读，不修改文件；单文件 ≤100MB；每轮最多 10 个文件；只发回当前来源会话，不能指定别的渠道或别人。\n" +
    "无 file 能力的渠道会自动降级为文本「[文件] 名字」。\n" +
    "参数：path (必填，文件绝对路径)，name (可选，展示名，缺省用文件名)。",
  enabled: true,
  risk: "fs-read",
  modes: ["chat", "learn", "code", "work"],
  effectKind: "read" as const,
  isConcurrencySafe: () => true,
  verificationPolicy: "none" as const,
  needsContext: true,
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "要发送的文件绝对路径" },
      name: { type: "string", description: "展示文件名（可选，缺省用文件本名）" },
    },
    required: ["path"],
  },
  execute: executeSendFile,
};
