import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveGitExecutable, type ResolvedGitExecutable } from "./git-executable";
import { createGitService } from "./git-service";

const fixtures: string[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await rm(fixture, { recursive: true, force: true });
});

function service(root: string, executable: ResolvedGitExecutable) {
  return createGitService({
    getSession: () => ({ mode: "code", workspaceBinding: { workspaceRoot: root, displayName: "fixture", boundAt: 0 } }),
    resolveExecutable: async () => executable,
    workspaceWatcher: { subscribe: async () => {}, unsubscribe: async () => {}, dispose: async () => {} },
  });
}

describe("真实 Git 可执行文件路径", () => {
  it("系统 Git 缺失时通过含空格和中文的内置路径完成初始化、提交和读取", async () => {
    const fixture = await mkdtemp(path.join(os.tmpdir(), "cyrene-git-path-"));
    fixtures.push(fixture);
    const repo = path.join(fixture, "代码 仓库");
    await mkdir(repo);
    const installed = execFileSync(process.platform === "win32" ? "where.exe" : "which", ["git"], { encoding: "utf8", windowsHide: true }).trim().split(/\r?\n/)[0];
    let bundledPath: string;
    if (process.platform === "win32") {
      // 保留 Git for Windows 的完整相对目录结构，不复制或修改系统安装。
      const alias = path.join(fixture, "内置 Git");
      await symlink(path.dirname(path.dirname(installed)), alias, "junction");
      bundledPath = path.join(alias, path.basename(path.dirname(installed)), path.basename(installed));
    } else {
      bundledPath = path.join(fixture, "内置 git");
      await symlink(installed, bundledPath);
    }
    const executable = await resolveGitExecutable({ systemCommand: path.join(fixture, "missing-git"), bundledPath });
    expect(executable?.source).toBe("bundled");
    if (!executable) throw new Error("测试环境需要可用 Git");
    executable.env = {
      ...executable.env,
      // 服务层必须重新固定配置，不能信任已解析对象随后附带的任意覆盖。
      GIT_CONFIG_GLOBAL: path.join(fixture, "must-not-read-config"),
      GIT_PAGER: "must-not-run-pager", GIT_SSH_COMMAND: "must-not-run-ssh",
      GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.pager", GIT_CONFIG_VALUE_0: "must-not-run-pager",
      GIT_AUTHOR_NAME: "Cyrene Test", GIT_AUTHOR_EMAIL: "test@example.invalid",
      GIT_COMMITTER_NAME: "Cyrene Test", GIT_COMMITTER_EMAIL: "test@example.invalid",
    };
    const current = service(repo, executable);
    const ctx = { sessionId: "fixture", mode: "code" as const, workspaceRoot: repo };
    try {
      const initial = await current.getStatusForSession("fixture");
      expect(initial.state, initial.message).toBe("not_repository");
      await current.initRepository(ctx);
      await writeFile(path.join(repo, "hello.txt"), "hello\n");
      expect(await current.commit(ctx, "测试提交", ["hello.txt"])).toContain("已创建提交");
      expect((await current.getStatusForSession("fixture")).state).toBe("ready");
      expect((await current.log(ctx))[0].message).toBe("测试提交");
      expect((await current.diff(ctx)).patch).toBe("");
    } finally {
      await current.dispose();
    }
  }, 20_000);

  it("系统 Git 命令保持可用，且不放宽系统命令字符串的校验", async () => {
    const fixture = await mkdtemp(path.join(os.tmpdir(), "cyrene-git-system-"));
    fixtures.push(fixture);
    const executable = { command: "git", source: "system" as const, version: "test" };
    const current = service(fixture, executable);
    expect((await current.getStatusForSession("fixture")).state).toBe("not_repository");
    await current.dispose();
    const invalid = service(fixture, { ...executable, command: "git --version" });
    expect((await invalid.getStatusForSession("fixture")).state).toBe("error");
    await invalid.dispose();
  });

  it("拒绝用相对路径冒充内置 Git", async () => {
    const current = service(os.tmpdir(), { command: "git", source: "bundled", version: "test" });
    expect(await current.getStatusForSession("fixture")).toMatchObject({ state: "error", message: "内置 Git 必须使用已探测的绝对路径" });
    await current.dispose();
  });
});
