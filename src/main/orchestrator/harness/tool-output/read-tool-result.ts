import type { ToolCall, ToolSpec } from "../../vendors/types";
import type { ToolContext } from "../../tools/registry/tool-context";
import type { ToolObservation } from "../types";
import { parseToolCallArgs } from "../types";
import {
  ToolOutputCorruptError,
  ToolOutputInvalidInputError,
  toolOutputRecordId,
  toolOutputResultRef,
} from "./file-tool-output-store";
import type { ToolOutputStore } from "./tool-output-store";
import { isDesktopBrowserTool } from "../../../browser/browser-tool-policy";

export const READ_TOOL_RESULT_TOOL_ID = "read_tool_result";

export const readToolResultToolSpec: ToolSpec = {
  name: READ_TOOL_RESULT_TOOL_ID,
  description: [
    "按需读取此前工具调用保存的完整结果。",
    "仅当上一轮 preview 不足以完成当前决策时使用；不要习惯性重读全部结果。",
    "提供 result_ref 可读取当前会话的任意已保存结果；只提供 tool_call_id 时只读取当前 Run 的对应结果。",
    "offset 和返回的 query 匹配位置均按 Unicode 码点计数；每次读取最多 8192 个码点。",
    "query 是纯文本查找，不支持正则表达式。不要提供文件系统路径。",
  ].join("\n"),
  parameters: {
    type: "object",
    properties: {
      result_ref: { type: "string", description: "上一轮 observation 中的 tool-result:// 引用" },
      tool_call_id: { type: "string", description: "当前 Run 中要读取的工具调用 ID" },
      offset: { type: "number", description: "读取起点；Unicode 码点坐标，默认 0" },
      length: { type: "number", description: "读取长度；默认 4096，最大 8192" },
      query: { type: "string", description: "可选纯文本查找词；返回匹配位置和附近片段" },
    },
  },
};

export async function executeReadToolResult(
  call: ToolCall,
  store: ToolOutputStore | undefined,
  toolContext: ToolContext | undefined,
): Promise<ToolObservation> {
  if (!store) {
    return runtimeSafety("工具结果存储未注入，当前运行无法读取完整结果");
  }
  const args = parseToolCallArgs(call);
  const resultRef = resolveResultRef(args, toolContext);
  if ("error" in resultRef) return resultRef.error;

  const query = typeof args.query === "string" ? args.query : undefined;
  const lookup = {
    conversationId: toolContext!.conversationId!,
    resultRef: resultRef.value,
    ...(toolContext?.channelRun ? { canReadTool: (name: string) => !isDesktopBrowserTool(name) } : {}),
  };
  try {
    if (query !== undefined) {
      const found = await store.find({
        ...lookup,
        query,
      });
      if (!found) return notFound();
      return {
        outcome: "success",
        tool: READ_TOOL_RESULT_TOOL_ID,
        message: found.matches.length > 0
          ? `在完整工具结果中找到 ${found.matches.length} 处匹配`
          : "完整工具结果中没有匹配内容",
        output: JSON.stringify(found),
      };
    }

    const offset = args.offset === undefined ? 0 : args.offset;
    const length = args.length === undefined ? 4_096 : args.length;
    if (typeof offset !== "number" || typeof length !== "number") {
      return invalidArguments("offset 和 length 必须是数字");
    }
    const read = await store.read({
      ...lookup,
      offset,
      length,
    });
    if (!read) return notFound();
    return {
      outcome: "success",
      tool: READ_TOOL_RESULT_TOOL_ID,
      message: `已读取完整工具结果的第 ${read.offset} 个码点起内容`,
      output: JSON.stringify(read),
    };
  } catch (error) {
    if (error instanceof ToolOutputInvalidInputError) return invalidArguments(error.message);
    if (error instanceof ToolOutputCorruptError) return runtimeSafety("工具结果记录损坏，无法安全读取");
    return runtimeSafety("工具结果读取失败");
  }
}

function resolveResultRef(
  args: Record<string, unknown>,
  toolContext: ToolContext | undefined,
): { value: string } | { error: ToolObservation } {
  const explicit = typeof args.result_ref === "string" ? args.result_ref.trim() : "";
  if (explicit) {
    if (!toolContext?.conversationId) return { error: runtimeSafety("读取工具结果缺少当前会话标识") };
    return { value: explicit };
  }

  const toolCallId = typeof args.tool_call_id === "string" ? args.tool_call_id.trim() : "";
  if (!toolCallId) return { error: invalidArguments("result_ref 与 tool_call_id 至少提供一个") };
  if (!toolContext?.conversationId || !toolContext.runId) {
    return { error: runtimeSafety("按 tool_call_id 读取需要当前会话和运行标识") };
  }
  return { value: toolOutputResultRef(toolOutputRecordId(toolContext.conversationId, toolContext.runId, toolCallId)) };
}

function invalidArguments(message: string): ToolObservation {
  return { outcome: "failure", category: "invalid_arguments", tool: READ_TOOL_RESULT_TOOL_ID, message };
}

function notFound(): ToolObservation {
  return { outcome: "failure", category: "not_found", tool: READ_TOOL_RESULT_TOOL_ID, message: "未找到可读取的工具结果" };
}

function runtimeSafety(message: string): ToolObservation {
  return { outcome: "failure", category: "runtime_safety", tool: READ_TOOL_RESULT_TOOL_ID, message };
}
