import type { GitDiffQuery, GitLogQuery, GitService, TrustedGitContext } from "../../code-git/git-service";
import type { ToolContext } from "./registry/tool-context";
import type { ToolDefinition } from "./registry/tool-registry";
import type { ToolFileChange } from "../../../shared/chat-types";
import { finalizeFileChanges, parseUnifiedPatch } from "./registry/tool-evidence";

export function createCodeGitTools(gitService: GitService): ToolDefinition[] {
  // Git 写操作可能执行 hooks、filters 或其他外部程序，且不经过 Shell 沙箱。
  // 统一按 input-control 审批，不能把它们当作仅限工作区的 fs-write。
  return [
    {
      id: "git_status",
      name: "Git 状态",
      description: "读取当前 Code 工作区的 Git 分支、变更和同步状态。",
      enabled: true,
      modes: ["code"],
      risk: "fs-read",
      effectKind: "read",
      verificationPolicy: "none",
      needsContext: true,
      inputSchema: { type: "object", properties: {} },
      execute: async (_args, ctx) => JSON.stringify(await gitService.getStatusForSession(requireCodeContext(ctx).sessionId)),
    },
    {
      id: "git_init",
      name: "初始化 Git 仓库",
      description: "仅在用户明确要求时，为当前 Code 工作区初始化 Git 仓库。",
      enabled: true,
      modes: ["code"],
      risk: "input-control",
      effectKind: "mutation",
      verificationPolicy: "artifact",
      needsContext: true,
      inputSchema: { type: "object", properties: {} },
      execute: async (_args, ctx) => gitService.initRepository(requireWritableCodeContext(ctx)),
    },
    {
      id: "git_commit",
      name: "提交 Git 变更",
      description: "把用户确认的仓库内文件加入暂存并创建一次 Git 提交。",
      enabled: true,
      modes: ["code"],
      risk: "input-control",
      effectKind: "mutation",
      verificationPolicy: "artifact",
      needsContext: true,
      inputSchema: {
        type: "object",
        properties: {
          message: { type: "string", description: "提交信息" },
          paths: { type: "array", description: "要提交的仓库内相对路径", items: { type: "string" } },
        },
        required: ["message", "paths"],
      },
      execute: async (args, ctx) => gitService.commit(
        requireWritableCodeContext(ctx),
        stringArg(args, "message"),
        stringArrayArg(args, "paths"),
      ),
    },
    {
      id: "git_switch_branch",
      name: "切换 Git 分支",
      description: "切换到现有分支，或按用户请求创建并切换新分支。",
      enabled: true,
      modes: ["code"],
      risk: "input-control",
      effectKind: "mutation",
      verificationPolicy: "artifact",
      needsContext: true,
      inputSchema: {
        type: "object",
        properties: {
          branch: { type: "string", description: "目标分支名称" },
          create: { type: "string", description: "是否创建新分支，true 或 false", enum: ["true", "false"], default: "false" },
        },
        required: ["branch"],
      },
      execute: async (args, ctx) => gitService.switchBranch(
        requireWritableCodeContext(ctx),
        stringArg(args, "branch"),
        args.create === true || args.create === "true",
      ),
    },
    {
      id: "git_push",
      name: "推送 Git 提交",
      description: "把当前分支推送到用户指定的远端；不会强制推送。",
      enabled: true,
      modes: ["code"],
      risk: "input-control",
      effectKind: "external_side_effect",
      verificationPolicy: "none",
      needsContext: true,
      inputSchema: {
        type: "object",
        properties: { remote: { type: "string", description: "远端名称，默认 origin", default: "origin" } },
      },
      execute: async (args, ctx) => gitService.push(requireWritableCodeContext(ctx), optionalStringArg(args, "remote")),
    },
    {
      id: "git_revert",
      name: "回退 Git 提交",
      description: "为指定提交创建一个新的 revert 提交，不会重写历史。",
      enabled: true,
      modes: ["code"],
      risk: "input-control",
      effectKind: "mutation",
      verificationPolicy: "artifact",
      needsContext: true,
      inputSchema: {
        type: "object",
        properties: { commit: { type: "string", description: "要回退的提交 hash" } },
        required: ["commit"],
      },
      execute: async (args, ctx) => gitService.revert(requireWritableCodeContext(ctx), stringArg(args, "commit")),
    },
    {
      id: "git_diff",
      name: "查看 Git 差异",
      description:
        "查看当前工作区的 Git diff（改动内容）。默认对比工作区 vs HEAD；staged=true 查看已暂存的改动；可用 ref 指定其他基准（分支名、tag、commit hash），paths 限定文件。\n" +
        "何时用：提交前自查改动、review 用户未提交的修改、revert 前确认影响面。",
      enabled: true,
      modes: ["code"],
      risk: "fs-read",
      effectKind: "read",
      verificationPolicy: "none",
      needsContext: true,
      inputSchema: {
        type: "object",
        properties: {
          ref: { type: "string", description: "基准 ref（分支/tag/hash），默认 HEAD" },
          staged: { type: "boolean", description: "true=已暂存的改动，false=工作区改动（默认）" },
          paths: { type: "array", items: { type: "string" }, description: "限定仓库内相对路径" },
          maxPatchLines: { type: "number", description: "patch 最多返回行数，默认 400，超出截断" },
        },
      },
      execute: async (args, ctx) => {
        const options: GitDiffQuery = {};
        if (args.ref !== undefined) options.ref = stringArg(args, "ref");
        if (args.staged !== undefined) options.staged = args.staged === true || args.staged === "true";
        if (args.paths !== undefined) options.paths = stringArrayArg(args, "paths");
        if (args.maxPatchLines !== undefined) options.maxPatchLines = Number(args.maxPatchLines);
        const result = await gitService.diff(requireCodeContext(ctx), options);

        // patch 按 "diff --git" 分段，配合 perFile 统计生成 Diff Review 卡片证据
        const segments = result.patch.split(/(?=^diff --git )/m).filter((s) => s.startsWith("diff --git"));
        const segmentByFile = new Map<string, string>();
        for (const segment of segments) {
          const match = segment.match(/^diff --git a\/(.+?) b\//m);
          if (match) segmentByFile.set(match[1], segment);
        }
        const changes: ToolFileChange[] = result.perFile.map((pf) => ({
          file: pf.file,
          kind: "modified",
          insertions: pf.insertions,
          deletions: pf.deletions,
          ...(segmentByFile.has(pf.file) ? { diff: parseUnifiedPatch(segmentByFile.get(pf.file)!) } : {}),
        }));

        return JSON.stringify({ ...result, changes: finalizeFileChanges(changes) });
      },
    },
    {
      id: "git_log",
      name: "查看 Git 历史",
      description:
        "查看提交历史（hash、日期、作者、提交信息）。可用 ref 指定分支，path 查看单文件历史，maxCount 控制条数（默认 20）。\n" +
        "何时用：了解某个文件为什么被改、找某次改动的提交 hash（配合 git_revert）、梳理近期变更。",
      enabled: true,
      modes: ["code"],
      risk: "fs-read",
      effectKind: "read",
      verificationPolicy: "none",
      needsContext: true,
      inputSchema: {
        type: "object",
        properties: {
          ref: { type: "string", description: "分支/tag/hash；默认当前分支" },
          path: { type: "string", description: "限定单个文件的仓库内相对路径" },
          maxCount: { type: "number", description: "最多返回条数（1-200），默认 20" },
        },
      },
      execute: async (args, ctx) => {
        const options: GitLogQuery = {};
        if (args.ref !== undefined) options.ref = stringArg(args, "ref");
        if (args.path !== undefined) options.path = stringArg(args, "path");
        if (args.maxCount !== undefined) options.maxCount = Number(args.maxCount);
        return JSON.stringify(await gitService.log(requireCodeContext(ctx), options));
      },
    },
  ];
}

export function registerCodeGitTools(
  gitService: GitService,
  registry: Pick<import("./registry/tool-registry").ToolRegistry, "register">,
): void {
  for (const tool of createCodeGitTools(gitService)) registry.register(tool);
}

function requireCodeContext(ctx: ToolContext | undefined): TrustedGitContext {
  if (ctx?.mode !== "code") throw new Error("Git 工具只允许在 Code 模式使用");
  if (!ctx.conversationId || !ctx.resolvedWorkspaceRoot) throw new Error("当前 Code 对话尚未绑定工作目录");
  return { sessionId: ctx.conversationId, mode: "code", workspaceRoot: ctx.resolvedWorkspaceRoot };
}

function requireWritableCodeContext(ctx: ToolContext | undefined): TrustedGitContext {
  // 子任务的只读契约独立于全局档位和 allow_all，必须在调用 Git 服务前拒绝。
  if (ctx?.readOnly) throw new Error("本子任务处于只读模式，不允许执行 Git 写操作。");
  return requireCodeContext(ctx);
}

function stringArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`缺少有效参数：${key}`);
  return value.trim();
}

function optionalStringArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  return stringArg(args, key);
}

function stringArrayArg(args: Record<string, unknown>, key: string): string[] {
  const value = args[key];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error(`缺少有效参数：${key}`);
  }
  return value.map((item) => item.trim());
}
