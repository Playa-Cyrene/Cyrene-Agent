import { describe, expect, it, vi } from "vitest";
import { devNull } from "node:os";
import { createBundledGitEnvironment, resolveGitExecutable } from "./git-executable";
const emptyGitConfig = process.platform === "win32" ? "NUL" : devNull;

describe("resolveGitExecutable", () => {
  it("prefers a working system Git over bundled MinGit", async () => {
    const probe = vi.fn(async (candidate: string) =>
      candidate === "git" ? "git version 2.55.0.windows.3" : "git version 2.55.0.windows.3",
    );

    const executable = await resolveGitExecutable({
      systemCommand: "git",
      bundledPath: "C:\\app\\resources\\mingit\\cmd\\git.exe",
      probe,
    });

    expect(executable).toMatchObject({
      command: "git",
      source: "system",
      version: "2.55.0.windows.3",
    });
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("uses isolated bundled MinGit only when system Git is unavailable", async () => {
    const probe = vi.fn(async (candidate: string) =>
      candidate === "git" ? null : "git version 2.55.0.windows.3",
    );

    const executable = await resolveGitExecutable({
      systemCommand: "git",
      bundledPath: "C:\\app\\resources\\mingit\\cmd\\git.exe",
      probe,
    });

    expect(executable).toMatchObject({
      command: "C:\\app\\resources\\mingit\\cmd\\git.exe",
      source: "bundled",
      version: "2.55.0.windows.3",
      env: {
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: emptyGitConfig,
      },
    });
    expect(probe).toHaveBeenNthCalledWith(1, "git");
    expect(probe).toHaveBeenNthCalledWith(2, "C:\\app\\resources\\mingit\\cmd\\git.exe");
  });

  it("reports unavailable when neither executable can run", async () => {
    const executable = await resolveGitExecutable({
      systemCommand: "git",
      bundledPath: "C:\\app\\resources\\mingit\\cmd\\git.exe",
      probe: async () => null,
    });

    expect(executable).toBeNull();
  });

  it("isolates bundled configuration and execution overrides without dropping process essentials", () => {
    const source = {
      PATH: "/system/bin", SystemRoot: "C:\\Windows", LANG: "zh_CN.UTF-8", GIT_AUTHOR_NAME: "Test Author",
      GIT_CONFIG_GLOBAL: "/host/config", git_config_system: "/host/system", GIT_CONFIG_NOSYSTEM: "0",
      GIT_CONFIG_PARAMETERS: "'core.pager=unsafe'", GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.sshCommand", GIT_CONFIG_VALUE_0: "unsafe",
      git_Pager: "unsafe", PAGER: "unsafe", EDITOR: "unsafe", VISUAL: "unsafe", PREFIX: "/host",
      SSH_ASKPASS: "unsafe", GIT_SSH_COMMAND: "unsafe", GIT_ASKPASS: "unsafe", GIT_EXEC_PATH: "/host",
      GIT_DIR: "/other/repo", GIT_WORK_TREE: "/other/tree",
    };
    expect(createBundledGitEnvironment(source)).toEqual({
      PATH: "/system/bin", SystemRoot: "C:\\Windows", LANG: "zh_CN.UTF-8", GIT_AUTHOR_NAME: "Test Author",
      GIT_CONFIG_GLOBAL: emptyGitConfig, GIT_CONFIG_NOSYSTEM: "1",
    });
    expect(source.GIT_CONFIG_GLOBAL).toBe("/host/config");
  });
});
