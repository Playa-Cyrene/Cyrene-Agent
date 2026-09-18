import type { TaskSubagentType } from "../../shared/task-session";
import type { ToolDefinition } from "./tools/registry/tool-registry";

/** 子任务永远不能再委托、直接等待用户或替父任务确认危险副作用。 */
const CHILD_BLOCKED_TOOL_IDS = new Set([
  "task",
  "ask_user",
  "ask_user_choice",
  "confirm_uncertain_effect",
]);

export interface TaskAgentProfile {
  id: TaskSubagentType;
  name: string;
  description: string;
  systemPrompt: string;
  allowedToolIds: "inherit" | readonly string[];
  timeoutMs: number;
}

const profiles: Record<TaskSubagentType, TaskAgentProfile> = {
  general: {
    id: "general",
    name: "通用子任务",
    description: "独立完成多步调查、文件操作或实现工作。",
    systemPrompt: [
      "你是为主代理工作的执行型子任务代理。",
      "只完成分配给你的任务并给出简洁、基于证据的结果；不要面向用户闲聊。",
      "不能询问用户，也不能再委托子任务；信息不足时如实说明阻塞原因。",
      "先使用已给上下文和工具验证，再报告结论、修改或产物路径。",
    ].join("\n"),
    allowedToolIds: "inherit",
    timeoutMs: 0,
  },
  document: {
    id: "document",
    name: "文档子任务",
    description: "生成并核验文档或工作文件。",
    systemPrompt: [
      "你是为主代理工作的文档执行子任务代理。",
      "只能处理分配的文档生成任务，不能询问用户或再委托。",
      "完成后必须报告实际产物路径，并在可用时验证文件已创建。",
      "若输入不足或生成失败，明确报告原因，不要猜测成功。",
    ].join("\n"),
    allowedToolIds: [
      "write_word",
      "write_excel",
      "write_pdf",
      "write_file",
      "read_file",
      "list_dir",
    ],
    timeoutMs: 0,
  },
  search: {
    id: "search",
    name: "搜索子任务",
    description: "搜索、阅读并整理带来源的事实。",
    systemPrompt: [
      "你是为主代理工作的搜索执行子任务代理。",
      "只能完成分配的研究任务，不能询问用户或再委托。",
      "报告事实时附上实际来源 URL，并把推断与来源事实区分开。",
      "无法验证的结论必须标明不确定性。",
    ].join("\n"),
    allowedToolIds: ["web_search", "fetch_url"],
    timeoutMs: 0,
  },
};

export function getTaskAgentProfile(type: TaskSubagentType): TaskAgentProfile {
  return profiles[type];
}

/** 只能缩小父工具集，绝不通过 profile 给子任务凭空增加工具。 */
export function resolveTaskTools(profile: TaskAgentProfile, parentTools: ToolDefinition[]): ToolDefinition[] {
  const allowed = profile.allowedToolIds === "inherit" ? null : new Set(profile.allowedToolIds);
  return parentTools.filter((tool) => !CHILD_BLOCKED_TOOL_IDS.has(tool.id)
    && (allowed === null || allowed.has(tool.id)));
}
