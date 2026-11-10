import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { devNull } from "node:os";

const execFileAsync = promisify(execFile);
// Git for Windows 拒绝 Node 的 \\.\nul 设备路径，使用它支持的 NUL 拼写。
const BUNDLED_GLOBAL_CONFIG = process.platform === "win32" ? "NUL" : devNull;

// 内置 Git 不继承宿主的外部命令、配置文件或仓库定位覆盖。
// 保留 PATH/SystemRoot、身份和区域设置等正常进程环境。
const BUNDLED_ENV_OVERRIDES = new Set([
  "EDITOR", "VISUAL", "PAGER", "PREFIX", "SSH_ASKPASS",
  "GIT_ASKPASS", "GIT_EDITOR", "GIT_EXEC_PATH", "GIT_EXTERNAL_DIFF", "GIT_PAGER",
  "GIT_PROXY_COMMAND", "GIT_TEMPLATE_DIR", "GIT_SEQUENCE_EDITOR", "GIT_SSH", "GIT_SSH_COMMAND",
  "GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES",
]);

export function createBundledGitEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    const upper = key.toUpperCase();
    if (upper.startsWith("GIT_CONFIG") || BUNDLED_ENV_OVERRIDES.has(upper)) continue;
    env[key] = value;
  }
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_CONFIG_GLOBAL = BUNDLED_GLOBAL_CONFIG;
  return env;
}

export interface ResolvedGitExecutable {
  command: string;
  source: "system" | "bundled";
  version: string;
  env?: NodeJS.ProcessEnv;
}

export interface ResolveGitExecutableDeps {
  systemCommand: string;
  bundledPath: string;
  probe?: (command: string) => Promise<string | null>;
}

export async function probeGitExecutable(command: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(command, ["--version"], {
      windowsHide: true,
      timeout: 3_000,
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

export async function resolveGitExecutable(
  deps: ResolveGitExecutableDeps,
): Promise<ResolvedGitExecutable | null> {
  const probe = deps.probe ?? probeGitExecutable;
  const systemVersion = await probe(deps.systemCommand);
  if (systemVersion) {
    return {
      command: deps.systemCommand,
      source: "system",
      version: parseGitVersion(systemVersion),
    };
  }

  const bundledVersion = await probe(deps.bundledPath);
  if (!bundledVersion) return null;

  return {
    command: deps.bundledPath,
    source: "bundled",
    version: parseGitVersion(bundledVersion),
    env: createBundledGitEnvironment(),
  };
}

function parseGitVersion(output: string): string {
  const match = output.match(/git version\s+(.+)/i);
  return match?.[1]?.trim() || output.trim();
}
