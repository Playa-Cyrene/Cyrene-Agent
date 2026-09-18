/**
 * 权限档位的纯策略层。
 *
 * 不依赖 Electron、磁盘或 IPC，供 VerificationRunner 等执行核心复用，
 * 避免为了判断 allow/ask/deny 就初始化整个权限宿主。
 */
import type { ToolRiskLevel } from "../shared/permission-approval";

export type AgentFileAccessLevel =
  | "project-read-only"
  | "read-only"
  | "scoped"
  | "per-action"
  | "full";

/**
 * 工具风险等级的唯一声明在 shared（审批载荷跨进程共用），此处再导出，
 * 保持既有引用方（permission.ts / tool-registry 等）不变。
 */
export type { ToolRiskLevel };

export function policyFor(
  level: AgentFileAccessLevel,
  risk: ToolRiskLevel,
): "allow" | "ask" | "deny" {
  if (risk === "safe") return "allow";

  // shell 的安全边界由沙箱兜底：所有档位都放行进 executeRunShell 的档位路由，
  // 由 buildFilesystemConfigForLevel + wrapWithSandbox 强制 fs 边界。
  // 不再用 policyFor 作为 shell 的准入闸门。
  if (risk === "shell") {
    switch (level) {
      case "project-read-only":
      case "read-only":
      case "scoped":
      case "full":
        return "allow";
      case "per-action":
        return "ask";
    }
  }

  switch (level) {
    case "project-read-only":
      // 档位控制的是沙箱 fs 配置（allowRead 限定项目根），不是工具准入。
      return risk === "fs-read" || risk === "network" ? "allow" : "deny";
    case "read-only":
      return risk === "fs-read" || risk === "network" ? "allow" : "deny";
    case "scoped":
      if (risk === "fs-read" || risk === "fs-write" || risk === "network") return "allow";
      return "deny";
    case "per-action":
      return "ask";
    case "full":
      return "allow";
  }
}
