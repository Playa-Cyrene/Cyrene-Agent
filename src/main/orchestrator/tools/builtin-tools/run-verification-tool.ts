// ── 工具：run_verification（受限验证工具）─────────────────────
// 唯一能产生可信 verification evidence 的工具。
// 只执行预定义的验证命令（typecheck/test/build/lint），不接受任意命令。
// ledgerPolicy=bypass：不缓存验证结果（相同参数在新 revision 下必须重新执行）。
//
// 原样迁自 built-in-tools.ts（纯搬移，逻辑未改）。注册方式调整：本模块导出
// runVerificationTool 常量，由 built-in-tools.ts facade 在原注册位置统一
// toolRegistry.register，显式保证 registry 插入顺序（= 工具目录 prompt 生成顺序，
// 门禁见 built-in-tools.snapshot.test.ts）。

import type { ToolDefinition } from "../registry/tool-registry";
import { VerificationRunner, resolveBuiltinExecutable } from "../../verification-runner";
import { resolveWorkspaceBuildCommand } from "../../workspace-build-command";

const LOG_PREFIX = "[BuiltinTools]";

// ── 工具：run_verification（受限验证工具）─────────────────────
// 唯一能产生可信 verification evidence 的工具。
// 只执行预定义的验证命令（typecheck/test/build/lint），不接受任意命令。
// ledgerPolicy=bypass：不缓存验证结果（相同参数在新 revision 下必须重新执行）。
export const runVerificationTool: ToolDefinition = {
  id: "run_verification",
  name: "运行验证",
  description:
    "执行代码验证（类型检查/测试/构建/lint）。是唯一能产生可信验证证据的工具。\n\n" +
    "何时用：\n" +
    "- 代码修改后需要验证编译是否通过\n" +
    "- 需要运行测试确认修改正确\n" +
    "- 需要 lint 检查代码风格\n\n" +
    "不要用于：\n" +
    "- 读取文件内容 → Read\n" +
    "- 执行任意命令 → run_shell\n" +
    "- 修改代码 → Edit/Write\n\n" +
    "参数：verificationType（验证类型：typecheck/test/build/lint），cwd（可选工作目录）。",
  enabled: true,
  risk: "shell",
  modes: ["code", "work"],
  effectKind: "verification" as const,
  ledgerPolicy: "bypass" as const,
  inputSchema: {
    type: "object",
    properties: {
      verificationType: {
        type: "string",
        enum: ["typecheck", "test", "build", "lint"],
        description: "验证类型：typecheck=类型检查，test=运行测试，build=构建，lint=代码风格检查",
      },
      cwd: { type: "string", description: "工作目录绝对路径，可选" },
    },
    required: ["verificationType"],
  },
  execute: async (args) => {
    const verificationType = String(args.verificationType || "").trim();
    const cwd = args.cwd ? String(args.cwd) : undefined;

    if (!verificationType) return JSON.stringify({
      success: false, errorCode: "INVALID_INPUT", error: "verificationType 不能为空",
      verificationType: "", command: "", exitCode: -1,
      stdout: "", stderr: "[错误] verificationType 不能为空",
      timedOut: false, passed: false, truncated: false, durationMs: 0, retryable: false,
    });

    // 根据验证类型选择命令（白名单，不接受任意命令）
    const fs = require("fs");
    const path = require("path");

    type WorkVerificationCommand = {
      cmd: string;
      args: string[];
      trust: "builtin" | "workspace_script";
      source: "tsconfig" | "vitest" | "package_script";
      configPath?: string;
    };
    let verificationCommands: Record<string, WorkVerificationCommand>;
    const actualCwd = cwd || process.cwd();

    if (verificationType === "typecheck") {
      // 1. 确定 tsconfig 路径
      let tsconfigPath: string;
      if (cwd) {
        const hasMain = fs.existsSync(path.join(cwd, "tsconfig.main.json"));
        const hasDefault = fs.existsSync(path.join(cwd, "tsconfig.json"));
        if (hasMain) {
          tsconfigPath = path.join(cwd, "tsconfig.main.json");
        } else if (hasDefault) {
          tsconfigPath = path.join(cwd, "tsconfig.json");
        } else {
          return JSON.stringify({
            success: false, errorCode: "VERIFICATION_CONFIG_NOT_FOUND",
            error: `cwd 下未找到 tsconfig.main.json 或 tsconfig.json: ${cwd}`,
            verificationType, command: "", exitCode: -1,
            stdout: "", stderr: `[错误] 未找到 TypeScript 配置文件: ${cwd}`,
            timedOut: false, passed: false, truncated: false, durationMs: 0, retryable: false,
            actualCwd: cwd,
          });
        }
      } else {
        tsconfigPath = "tsconfig.main.json";
      }

      // 2. 复用 VerificationRunner 的本地 CLI 解析（禁止 npx / 全局 PATH）
      if (!resolveBuiltinExecutable("builtin:tsc", actualCwd, tsconfigPath)) {
        return JSON.stringify({
          success: false, errorCode: "TYPESCRIPT_NOT_FOUND",
          error: `本地 TypeScript 未安装: ${actualCwd}`,
          verificationType, command: "", exitCode: -1,
          stdout: "", stderr: `[TYPESCRIPT_NOT_FOUND] local typescript CLI not found in ${actualCwd}`,
          timedOut: false, passed: false, truncated: false, durationMs: 0, retryable: false,
          actualCwd: cwd,
        });
      }

      verificationCommands = {
        typecheck: {
          cmd: "builtin:tsc",
          args: ["-p", tsconfigPath, "--noEmit"],
          trust: "builtin",
          source: "tsconfig",
          configPath: tsconfigPath,
        },
      };
    } else if (verificationType === "build") {
      const buildCommand = await resolveWorkspaceBuildCommand(actualCwd);
      if (!buildCommand.ok) {
        return JSON.stringify({
          success: false,
          errorCode: buildCommand.errorCode,
          error: buildCommand.error,
          verificationType,
          command: "",
          exitCode: -1,
          stdout: "",
          stderr: `[${buildCommand.errorCode}] ${buildCommand.error}`,
          timedOut: false,
          passed: false,
          truncated: false,
          durationMs: 0,
          retryable: false,
          actualCwd,
        });
      }
      verificationCommands = {
        build: {
          cmd: buildCommand.command,
          args: buildCommand.args,
          trust: "workspace_script",
          source: "package_script",
        },
      };
    } else {
      verificationCommands = {
        test: {
          cmd: "builtin:vitest",
          // 显式 default reporter：低噪声（逐文件 + 末尾汇总），且不依赖项目
          // vitest.config 里可能配置的 reporters（若项目自己配了 verbose，不传参会被带回去）
          args: ["--reporter=default"],
          trust: "builtin",
          source: "vitest",
        },
        lint: {
          cmd: process.execPath,
          args: [],
          trust: "workspace_script",
          source: "package_script",
        },
      };
    }

    const command = verificationCommands[verificationType];
    if (!command) return JSON.stringify({
      success: false, errorCode: "INVALID_INPUT",
      error: `不支持的验证类型: ${verificationType}，支持: typecheck/test/build/lint`,
      verificationType, command: "", exitCode: -1,
      stdout: "", stderr: `[错误] 不支持的验证类型: ${verificationType}`,
      timedOut: false, passed: false, truncated: false, durationMs: 0, retryable: false,
    });

    if (verificationType === "test" && !resolveBuiltinExecutable("builtin:vitest", actualCwd)) {
      return JSON.stringify({
        success: false, errorCode: "VITEST_NOT_FOUND",
        error: `本地 Vitest 未安装: ${actualCwd}`,
        verificationType, command: "", exitCode: -1,
        stdout: "", stderr: `[VITEST_NOT_FOUND] local vitest CLI not found in ${actualCwd}`,
        timedOut: false, passed: false, truncated: false, durationMs: 0, retryable: false,
        actualCwd,
      });
    }
    if (verificationType === "lint") {
      try {
        const eslintPath = require.resolve("eslint/bin/eslint.js", { paths: [actualCwd] });
        if (!fs.existsSync(eslintPath) || !path.isAbsolute(eslintPath)) throw new Error("invalid eslint path");
        command.args = [eslintPath, "src/main", "--max-warnings=0"];
      } catch {
        return JSON.stringify({
          success: false, errorCode: "ESLINT_NOT_FOUND",
          error: `本地 ESLint 未安装: ${actualCwd}`,
          verificationType, command: "", exitCode: -1,
          stdout: "", stderr: `[ESLINT_NOT_FOUND] local eslint CLI not found in ${actualCwd}`,
          timedOut: false, passed: false, truncated: false, durationMs: 0, retryable: false,
          actualCwd,
        });
      }
    }

    const resolvedForDisplay = resolveBuiltinExecutable(command.cmd, actualCwd, command.configPath);
    const displayExecutable = resolvedForDisplay?.executable ?? command.cmd;
    const displayArgs = [...(resolvedForDisplay?.args ?? []), ...command.args];
    const startMs = Date.now();
    const actualCommand = `${displayExecutable} ${displayArgs.join(" ")}`;
    console.log(LOG_PREFIX, "run_verification:", verificationType, actualCommand, cwd ? "cwd=" + cwd : "");

    // 复用 Code 模式的 VerificationRunner（同一个执行核心）
    // 旧协议 JSON 输出格式保持不变
    const runner = new VerificationRunner();
    try {
      const result = await runner.runStep({
        id: `run_verification_${verificationType}`,
        type: verificationType as any,
        packageRoot: cwd || process.cwd(),
        cwd: cwd || process.cwd(),
        configPath: command.configPath,
        trust: command.trust,
        executable: command.cmd,
        args: command.args,
        source: command.source,
      }, {
        // 仅在工具真实执行时读取宿主档位；模块加载阶段保持 VerificationRunner 纯净。
        permissionLevel: (await import("../../../permission.js")).getCurrentLevel(),
        signal: undefined,
      });

      const durationMs = Date.now() - startMs;
      const passed = result.passed;
      console.log(LOG_PREFIX, "run_verification 完成:", verificationType,
        "exitCode=" + result.exitCode, "passed=" + passed, "durationMs=" + durationMs,
        "stdoutLen=" + result.stdout.length, "stderrLen=" + result.stderr.length);

      // 兼容旧协议 JSON：errorCode 来自 result.errorCode
      const errorCode = result.errorCode;
      const isApprovalRequired = errorCode === "VERIFICATION_APPROVAL_REQUIRED";
      const isTimeout = errorCode === "VERIFICATION_TIMEOUT" || result.timedOut;

      return JSON.stringify({
        // 旧协议中 success 表示“命令已被 Runner 正常接管”，退出码由 passed 表示。
        success: !isApprovalRequired && !isTimeout,
        verificationType,
        command: actualCommand,
        actualCwd: cwd || process.cwd(),
        exitCode: result.exitCode ?? -1,
        // stdout 置尾：保证下游截断的尾窗覆盖测试汇总行（Test Files/Tests passed）
        stderr: result.stderr,
        stdout: result.stdout,
        spawnError: null,
        timedOut: result.timedOut,
        passed,
        truncated: result.stdout.includes("... (truncated") || result.stderr.includes("... (truncated"),
        durationMs,
        errorCode,
        retryable: isTimeout,
        ...(isApprovalRequired ? { approvalRequired: true } : {}),
      });
    } catch (err) {
      const durationMs = Date.now() - startMs;
      const msg = err instanceof Error ? err.message : String(err);
      console.error(LOG_PREFIX, "run_verification 失败:", verificationType, "error:", msg);
      return JSON.stringify({
        success: false,
        errorCode: "VERIFICATION_SPAWN_FAILED",
        error: `命令启动失败: ${msg}`,
        verificationType,
        command: actualCommand,
        actualCwd: cwd || process.cwd(),
        exitCode: -1,
        stdout: "",
        stderr: `[VERIFICATION_SPAWN_FAILED] ${msg}`,
        spawnError: { code: undefined, message: msg },
        timedOut: false,
        passed: false,
        truncated: false,
        durationMs,
        retryable: false,
      });
    }
  },
};
