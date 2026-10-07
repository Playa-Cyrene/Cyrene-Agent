import type { TaskAccessMode, TaskSubagentType } from "../../shared/task-session";
import type { ToolDefinition } from "./tools/registry/tool-registry";
import { MINIMAX_SEARCH_TOOL_PREFIX } from "./search-backend-filter";
import { READ_TOOL_RESULT_TOOL_ID } from "./harness/tool-output/read-tool-result";

const BASIC_TASK_TOOL_IDS = [
  "run_shell", "Glob", "Grep", "Read", "Write", "Edit", "invoke_skill", "read_skill_reference",
] as const;

/** 子任务只保留读取完整工具结果这一项运行层辅助能力。 */
export const TASK_BUILTIN_TOOL_IDS: ReadonlySet<string> = new Set([READ_TOOL_RESULT_TOOL_ID]);

/** 子任务永远不能再委托、直接等待用户或替父任务确认危险副作用。 */
const CHILD_BLOCKED_TOOL_IDS = new Set([
  "task",
  "close_task",
  "ask_user",
  "ask_user_choice",
  "confirm_uncertain_effect",
]);

export interface TaskAgentProfile {
  id: TaskSubagentType;
  name: string;
  description: string;
  allowedToolIds: readonly string[];
  timeoutMs: number;
}

const profiles: Record<TaskSubagentType, TaskAgentProfile> = {
  general: {
    id: "general",
    name: "通用子任务",
    description: "独立完成多步调查、文件操作或实现工作。",
    allowedToolIds: BASIC_TASK_TOOL_IDS,
    timeoutMs: 0,
  },
  document: {
    id: "document",
    name: "文档子任务",
    description: "生成并核验文档或工作文件。",
    allowedToolIds: BASIC_TASK_TOOL_IDS,
    timeoutMs: 0,
  },
  search: {
    id: "search",
    name: "搜索子任务",
    description: "搜索、阅读并整理带来源的事实。",
    allowedToolIds: [...BASIC_TASK_TOOL_IDS, "web_search", "fetch_url"],
    timeoutMs: 0,
  },
};

export function getTaskAgentProfile(type: TaskSubagentType): TaskAgentProfile {
  return profiles[type];
}

/** 子任务不管理常驻进程；避免 shell 宣传未开放的 shell_job 工具。 */
function taskShellTool(tool: ToolDefinition): ToolDefinition {
  return {
    ...tool,
    description: "执行前台命令，返回退出码、标准输出和错误输出。默认在当前工作区执行；可指定权限允许的 cwd。"
      + "shell 支持 cmd（默认）或 bash（需要已安装 Git Bash）。文件读取、搜索和修改优先使用 Read、Glob、Grep、Write、Edit。"
      + "默认两分钟无输出终止，最长三十分钟；长时间无输出时指定 timeout_ms。常驻进程交给主代理处理。",
    inputSchema: {
      ...tool.inputSchema,
      properties: Object.fromEntries(Object.entries(tool.inputSchema.properties)
        .filter(([name]) => name !== "run_in_background")
        .map(([name, schema]) => [name, name === "timeout_ms"
          ? { ...schema, description: "执行上限毫秒数（1000–1800000）；指定后关闭两分钟无输出检测。" } : schema])),
    },
    execute: async (args, context) => {
      if (args.run_in_background === true || args.run_in_background === "true") {
        return JSON.stringify({ success: false, errorCode: "TASK_BACKGROUND_UNAVAILABLE",
          category: "invalid_arguments", error: "子任务只支持前台命令；后台常驻进程交给主代理处理。" });
      }
      return tool.execute(args, context);
    },
  };
}

/** 只能缩小父工具集，绝不通过 profile 给子任务凭空增加工具。 */
export function resolveTaskTools(
  profile: TaskAgentProfile,
  parentTools: ToolDefinition[],
  accessMode: TaskAccessMode = "write",
): ToolDefinition[] {
  const allowed = new Set(profile.allowedToolIds);
  return parentTools.flatMap((tool): ToolDefinition[] => {
    const searchBackend = profile.id === "search" && tool.id.startsWith(MINIMAX_SEARCH_TOOL_PREFIX);
    if (!tool.enabled || tool.deprecated || tool.browserControlPhase || CHILD_BLOCKED_TOOL_IDS.has(tool.id)
      || (!allowed.has(tool.id) && !searchBackend)) return [];
    if (accessMode !== "read_only") return [tool.id === "run_shell" ? taskShellTool(tool) : tool];
    // 动态副作用分类在模型提供真实参数前无法证明只读，保守地不暴露给只读子任务。
    return tool.effectKind === "read" && tool.effectResolver === undefined ? [tool] : [];
  });
}
