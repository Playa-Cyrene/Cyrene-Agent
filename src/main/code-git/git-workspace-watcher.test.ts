import { describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { createCodeGitIgnoredPredicate, createGitWorkspaceWatcher, type WorkspaceFsWatcher } from "./git-workspace-watcher";

/** 解析为规范长路径：CI 的临时目录含 Windows 短路径（RUNNER~1），
 *  短路径直接交给递归 fs.watch 会触发 libuv fs-event 断言，进程无输出直接退出。 */
function makeLongTempDir(prefix: string): string {
  return realpathSync.native(mkdtempSync(path.join(tmpdir(), prefix)));
}

function createWatcherHarness() {
  const listeners = new Map<string, (value?: unknown) => void>();
  const watcher: WorkspaceFsWatcher = {
    on: vi.fn((event: string, listener: (value?: unknown) => void) => {
      listeners.set(event, listener);
      return watcher;
    }),
    close: vi.fn(async () => undefined),
  };
  return { watcher, emit: (event: string, value?: unknown) => listeners.get(event)?.(value) };
}

describe("GitWorkspaceWatcher", () => {
  it("shares one watcher and broadcasts one debounced change to every session in a workspace", async () => {
    vi.useFakeTimers();
    const harness = createWatcherHarness();
    const createWatcher = vi.fn(() => harness.watcher);
    const changed = vi.fn();
    const watcher = createGitWorkspaceWatcher({ createWatcher, onWorkspaceChanged: changed, onError: vi.fn() });

    await watcher.subscribe({ sessionId: "s1", workspaceRoot: "C:\\repo", gitDir: "C:\\repo\\.git" });
    await watcher.subscribe({ sessionId: "s2", workspaceRoot: "C:\\repo", gitDir: "C:\\repo\\.git" });
    harness.emit("change", "C:\\repo\\src\\a.ts");
    harness.emit("change", "C:\\repo\\.git\\index");

    expect(createWatcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(299);
    expect(changed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(changed).toHaveBeenCalledWith(["s1", "s2"]);
    vi.useRealTimers();
  });

  it("keeps the shared watcher until the last session leaves", async () => {
    const harness = createWatcherHarness();
    const watcher = createGitWorkspaceWatcher({ createWatcher: () => harness.watcher, onWorkspaceChanged: vi.fn(), onError: vi.fn() });

    await watcher.subscribe({ sessionId: "s1", workspaceRoot: "C:\\repo", gitDir: "C:\\repo\\.git" });
    await watcher.subscribe({ sessionId: "s2", workspaceRoot: "C:\\repo", gitDir: "C:\\repo\\.git" });
    await watcher.unsubscribe("s1");
    expect(harness.watcher.close).not.toHaveBeenCalled();
    await watcher.unsubscribe("s2");
    expect(harness.watcher.close).toHaveBeenCalledTimes(1);
  });

  it("keeps a session watched until every consumer releases its subscription", async () => {
    const harness = createWatcherHarness();
    const watcher = createGitWorkspaceWatcher({ createWatcher: () => harness.watcher, onWorkspaceChanged: vi.fn(), onError: vi.fn() });

    await watcher.subscribe({ sessionId: "s1", workspaceRoot: "C:\\repo", gitDir: "C:\\repo\\.git" });
    await watcher.subscribe({ sessionId: "s1", workspaceRoot: "C:\\repo", gitDir: "C:\\repo\\.git" });
    await watcher.unsubscribe("s1");
    expect(harness.watcher.close).not.toHaveBeenCalled();
    await watcher.unsubscribe("s1");
    expect(harness.watcher.close).toHaveBeenCalledTimes(1);
  });

  it("keeps HEAD, index and refs while ignoring noisy git object paths", () => {
    const ignored = createCodeGitIgnoredPredicate({ workspaceRoot: "C:\\repo", gitDir: "C:\\repo\\.git" });

    expect(ignored("C:\\repo\\node_modules\\x.js")).toBe(true);
    expect(ignored("C:\\repo\\.git\\objects\\aa\\hash")).toBe(true);
    expect(ignored("C:\\repo\\.git\\HEAD")).toBe(false);
    expect(ignored("C:\\repo\\.git\\index")).toBe(false);
    expect(ignored("C:\\repo\\.git\\refs\\heads\\main")).toBe(false);
  });

  it("ignores release output and worktree directories that git does not track", () => {
    const ignored = createCodeGitIgnoredPredicate({ workspaceRoot: "C:\\repo", gitDir: "C:\\repo\\.git" });

    expect(ignored("C:\\repo\\release\\win-unpacked\\app.asar")).toBe(true);
    expect(ignored("C:\\repo\\release-verify\\win-unpacked\\app.asar")).toBe(true);
    expect(ignored("C:\\repo\\release-verify-fc\\win-unpacked\\app.asar")).toBe(true);
    expect(ignored("C:\\repo\\.worktrees\\task-todo-lsp\\src\\a.ts")).toBe(true);
    expect(ignored("C:\\repo\\tmp\\scratch.txt")).toBe(true);
  });
});

// 原生递归监视只在支持内核递归的平台上有效，其余平台跳过实盘验证
const itNative = process.platform === "win32" || process.platform === "darwin" ? it : it.skip;

describe("GitWorkspaceWatcher 原生递归监视（真实文件系统）", () => {
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  itNative("工作区文件变化触发一次防抖通知，忽略目录内的变化不触发", async () => {
    const root = makeLongTempDir("cyrene-watch-");
    const gitDir = path.join(root, ".git");
    mkdirSync(path.join(gitDir, "refs", "heads"), { recursive: true });
    writeFileSync(path.join(gitDir, "HEAD"), "ref: refs/heads/main\n");
    const changed = vi.fn();
    const watcher = createGitWorkspaceWatcher({ onWorkspaceChanged: changed, onError: vi.fn(), debounceMs: 80 });

    try {
      await watcher.subscribe({ sessionId: "s1", workspaceRoot: root, gitDir });
      await sleep(200); // 等内核监视句柄完成注册

      writeFileSync(path.join(root, "a.ts"), "1");
      await sleep(400);
      expect(changed).toHaveBeenCalledTimes(1);
      expect(changed).toHaveBeenCalledWith(["s1"]);

      // node_modules 里的写入经过忽略谓词过滤，不应触发刷新
      mkdirSync(path.join(root, "node_modules", "x"), { recursive: true });
      writeFileSync(path.join(root, "node_modules", "x", "y.js"), "1");
      await sleep(400);
      expect(changed).toHaveBeenCalledTimes(1);

      // git objects 噪音同样不应触发
      mkdirSync(path.join(gitDir, "objects", "aa"), { recursive: true });
      writeFileSync(path.join(gitDir, "objects", "aa", "hash"), "blob");
      await sleep(400);
      expect(changed).toHaveBeenCalledTimes(1);

      // HEAD 变化属于元数据变更，应当触发
      writeFileSync(path.join(gitDir, "HEAD"), "ref: refs/heads/dev\n");
      await sleep(400);
      expect(changed).toHaveBeenCalledTimes(2);
    } finally {
      await watcher.dispose();
      await sleep(100);
      rmSync(root, { recursive: true, force: true });
    }
  });

  itNative("worktree 场景：gitDir 在仓库外时元数据变化仍能触发", async () => {
    const base = makeLongTempDir("cyrene-worktree-");
    const root = path.join(base, "worktree");
    const gitDir = path.join(base, "mainrepo", ".git");
    mkdirSync(root, { recursive: true });
    mkdirSync(path.join(gitDir, "refs", "heads"), { recursive: true });
    writeFileSync(path.join(gitDir, "HEAD"), "ref: refs/heads/main\n");
    const changed = vi.fn();
    const watcher = createGitWorkspaceWatcher({ onWorkspaceChanged: changed, onError: vi.fn(), debounceMs: 80 });

    try {
      await watcher.subscribe({ sessionId: "s1", workspaceRoot: root, gitDir });
      await sleep(200);

      writeFileSync(path.join(gitDir, "HEAD"), "ref: refs/heads/dev\n");
      await sleep(400);
      expect(changed).toHaveBeenCalledTimes(1);

      // worktree 内的文件变化也要触发
      writeFileSync(path.join(root, "b.ts"), "1");
      await sleep(400);
      expect(changed).toHaveBeenCalledTimes(2);
    } finally {
      await watcher.dispose();
      await sleep(100);
      rmSync(base, { recursive: true, force: true });
    }
  });

  itNative("dispose 后句柄关闭，不再产生通知", async () => {
    const root = makeLongTempDir("cyrene-watch-");
    const gitDir = path.join(root, ".git");
    mkdirSync(gitDir, { recursive: true });
    const changed = vi.fn();
    const watcher = createGitWorkspaceWatcher({ onWorkspaceChanged: changed, onError: vi.fn(), debounceMs: 80 });

    await watcher.subscribe({ sessionId: "s1", workspaceRoot: root, gitDir });
    await watcher.dispose();
    await sleep(100);

    writeFileSync(path.join(root, "c.ts"), "1");
    await sleep(400);
    expect(changed).not.toHaveBeenCalled();
    rmSync(root, { recursive: true, force: true });
  });
});
