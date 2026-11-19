import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PluginManager, type PluginManagerOptions } from "./manager";
import { PLUGIN_CLEANUP_TIMEOUT_MS, type PluginRuntime } from "./context";
import { createPluginPromptRegistry } from "./prompts";
import { ChannelManager } from "../main/channels/manager";
import * as installer from "./installer";

let tmp: string;

function fixturePlugin(id: string, manifestId: string = id): string {
  if (!tmp) tmp = mkdtempSync(path.join(os.tmpdir(), "cyrene-mgr-test-"));
  const dir = path.join(tmp, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "manifest.json"),
    JSON.stringify({
      apiVersion: 1,
      id: manifestId,
      name: id,
      version: "1.0.0",
      description: "d",
      author: "a",
      entry: "index.cjs",
      defaultEnabled: true,
    }),
    "utf8",
  );
  writeFileSync(
    path.join(dir, "index.cjs"),
    `module.exports = { open() {}, register(ctx) {
      ctx.registerIpc("ping", () => "pong");
      ctx.registerTool({ id: "${id}_tool", name: "t", description: "d", enabled: true, inputSchema: { type: "object", properties: {}, required: [] }, execute: async () => "ok" });
    }, unregister() {} };`,
    "utf8",
  );
  return dir;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  if (tmp) {
    rmSync(tmp, { recursive: true, force: true });
    tmp = "";
  }
});

function harness(overrides: Partial<PluginManagerOptions> = {}) {
  const tools: string[] = [];
  const ipc = new Map<string, (...args: unknown[]) => unknown>();
  const promptRegistry = createPluginPromptRegistry();
  const runtime: PluginRuntime = {
    toolRegistry: {
      register: (t) => tools.push(t.id),
      unregister: (id) => {
        const i = tools.indexOf(id);
        if (i >= 0) tools.splice(i, 1);
        return true;
      },
    },
    channelManager: { has: () => false, register: () => {}, unregister: async () => true, startOne: async () => {} },
    registerIpc: (c, h) => ipc.set(c, h),
    unregisterIpc: (c) => ipc.delete(c),
    promptRegistry,
  };
  let enabledMap: Record<string, boolean> = {};
  const options: PluginManagerOptions = {
    scanRoots: [{ path: path.dirname(fixturePlugin("demo")), source: "builtin" }],
    storageRoot: path.join(tmp ?? "tmp", "storage"),
    runtime,
    loadEnabledMap: () => ({ ...enabledMap }),
    saveEnabledMap: (m) => {
      enabledMap = { ...m };
    },
    ...overrides,
  };
  return { options, tools, ipc, promptRegistry, getEnabledMap: () => ({ ...enabledMap }) };
}

describe("PluginManager", () => {
  it.each([
    ["conversation", true], ["conversation", false], ["scheduler", true], ["scheduler", false],
  ] as const)("includes Chat prompts in the first %s request (registered late=%s)", async (source, late) => {
    const h = harness();
    writeFileSync(path.join(tmp, "demo", "index.cjs"), `module.exports = {
      async register(ctx) {
        if (${!late}) ctx.registerPromptProvider({
          id: "early", modes: ["chat"], sources: ["conversation", "scheduler", "plugin-agent"], provide: () => "PLUGIN_CONTEXT"
        });
        await new Promise(resolve => ctx.registerIpc("release", resolve));
        if (${late}) ctx.registerPromptProvider({
          id: "late", modes: ["chat"], sources: ["conversation", "scheduler", "plugin-agent"], provide: () => "PLUGIN_CONTEXT"
        });
      }
    };`);
    const manager = new PluginManager(h.options);
    h.options.runtime.promptRegistry = {
      ...h.promptRegistry,
      register: (id, provider, signal) => h.promptRegistry.register(id, provider, signal, () => manager.isRunning(id)),
    };
    const starting = manager.start();
    let finished = false;
    const prompt = h.promptRegistry.build({ source, mode: "chat", userText: "first" }).then(text => { finished = true; return text; });
    await vi.waitFor(() => expect(h.ipc.has("plugin:demo:release")).toBe(true));
    expect(finished).toBe(false);
    expect(await h.promptRegistry.build({ source: "plugin-agent", mode: "chat", userText: "activation task" })).toBe("");
    h.ipc.get("plugin:demo:release")!();
    await starting;
    expect(await prompt).toContain("PLUGIN_CONTEXT");
    expect(await h.promptRegistry.build({ source, mode: "work", userText: "other" })).toBe("");
    await manager.stop();
  });

  it("allows a plugins:ready listener to build external prompt context", async () => {
    const h = harness();
    const file = path.join(tmp, "demo", "index.cjs");
    writeFileSync(file, `module.exports = {
      register(ctx) {
        ctx.registerPromptProvider({ id: "context", provide: () => "READY_CONTEXT" });
        ctx.events.on("host:plugins:ready", async () => {
          module.exports.result = await ctx.deps.llm.generateText([]);
        });
      }
    };`);
    const manifestPath = path.join(tmp, "demo", "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    writeFileSync(manifestPath, JSON.stringify({ ...manifest, deps: ["llm"] }));
    h.options.runtime.llm = {
      generateText: () => h.promptRegistry.build({ source: "conversation", mode: "chat", userText: "ready" }),
    };
    const manager = new PluginManager(h.options);
    await manager.start();
    expect((require(file) as { result: string }).result).toContain("READY_CONTEXT");
    await manager.stop();
  });

  it("times out a plugin after ten seconds and rejects its late registrations", async () => {
    const h = harness();
    let release!: () => void;
    const moduleFile = path.join(tmp, "demo", "index.cjs");
    writeFileSync(moduleFile, `module.exports = {
      async register(ctx) {
        module.exports.context = ctx;
        ctx.registerIpc("ping", () => "pong");
        await new Promise(resolve => { module.exports.release = resolve; });
        ctx.registerIpc("late", () => "late");
      }
    };`);
    fixturePlugin("healthy");
    vi.useFakeTimers();
    const manager = new PluginManager(h.options);
    const starting = manager.start();
    const firstPrompt = h.promptRegistry.build({ source: "conversation", mode: "chat", userText: "first" });
    await vi.advanceTimersByTimeAsync(0);
    const plugin = require(moduleFile) as { context: { signal: AbortSignal }; release(): void };
    const context = plugin.context;
    release = plugin.release;
    expect(context.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(9999);
    expect(manager.list()[0].status).toBe("starting");
    await vi.advanceTimersByTimeAsync(1);
    expect(manager.list()[0]).toMatchObject({ status: "failed", error: expect.stringContaining("10000") });
    await starting;
    expect(await firstPrompt).toBe("");
    expect(manager.isRunning("healthy")).toBe(true);
    expect(h.tools).toContain("healthy_tool");
    expect(context.signal.aborted).toBe(true);
    expect(h.ipc.has("plugin:demo:ping")).toBe(false);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.ipc.has("plugin:demo:late")).toBe(false);
    expect(manager.isRunning("demo")).toBe(false);
    await manager.stop();
  });

  it.each(["timeout", "shutdown"] as const)("cleans a pending plugin channel on %s and stops its late completion", async (action) => {
    const h = harness();
    const channels = new ChannelManager();
    const port = channels.createPluginPort();
    h.options.runtime.channelManager = port as unknown as PluginRuntime["channelManager"];
    const file = path.join(tmp, "demo", "index.cjs");
    writeFileSync(file, `module.exports = {
      async register(ctx) {
        const adapter = {
          id: "slow-channel", displayName: "slow", capability: {}, onMessage: null,
          start: () => new Promise(resolve => { module.exports.release = resolve; }),
          stop: async () => { module.exports.stops = (module.exports.stops || 0) + 1; }
        };
        await ctx.registerChannelAdapter(adapter);
      }
    };`);
    vi.useFakeTimers();
    const manager = new PluginManager(h.options);
    const starting = manager.start();
    await vi.advanceTimersByTimeAsync(0);
    const plugin = require(file) as { release(): void; stops?: number };
    expect(channels.has("slow-channel" as never)).toBe(true);
    if (action === "timeout") {
      await vi.advanceTimersByTimeAsync(10_000);
      await starting;
    } else {
      await manager.stop();
      await starting;
    }
    expect(channels.has("slow-channel" as never)).toBe(false);
    plugin.release();
    await vi.advanceTimersByTimeAsync(0);
    expect(plugin.stops).toBe(1);
    expect(manager.isRunning("demo")).toBe(false);
    await manager.stop();
  });

  it("启动时启用 defaultEnabled 插件并注册列表/开关 IPC", async () => {
    const h = harness();
    const mgr = new PluginManager(h.options);
    await mgr.start();
    expect(mgr.list().map((e) => e.id)).toEqual(["demo"]);
    expect(mgr.list()[0].enabled).toBe(true);
    expect(h.ipc.has("plugins:list")).toBe(true);
    expect(h.ipc.has("plugins:rescan")).toBe(true);
    expect(h.ipc.has("plugins:import-zip")).toBe(true);
    expect(h.ipc.has("plugins:uninstall")).toBe(true);
    expect(h.ipc.get("plugins:list")?.()).toMatchObject({
      plugins: [expect.objectContaining({ id: "demo", status: "running" })],
      issues: [],
    });
    expect(h.ipc.has("plugins:set-enabled")).toBe(true);
    expect(h.ipc.has("plugin:demo:ping")).toBe(true);
  });

  it("waits only for the selected plugin during startup", async () => {
    const h = harness();
    const slow = fixturePlugin("slow");
    writeFileSync(path.join(slow, "index.cjs"), `module.exports = {
      register(ctx) { return new Promise((resolve) => ctx.registerIpc("release", resolve)); }
    };`);
    const manager = new PluginManager(h.options);
    let reveal!: () => void;
    const starting = manager.start(new Promise<void>((resolve) => { reveal = resolve; }));
    const selectedReady = manager.waitForStartupTools((id) => id === "demo");
    expect(h.tools).toEqual([]);
    reveal();
    await selectedReady;
    expect(h.tools).toContain("demo_tool");
    await vi.waitFor(() => expect(h.ipc.has("plugin:slow:release")).toBe(true));
    expect(manager.isRunning("slow")).toBe(false);
    h.ipc.get("plugin:slow:release")!();
    await starting;
    expect(manager.isRunning("slow")).toBe(true);
    await manager.stop();
  });

  it("宿主事件可发布给插件，停用后监听器被移除", async () => {
    const h = harness();
    const marker = path.join(tmp, "host-event");
    writeFileSync(
      path.join(tmp, "demo", "index.cjs"),
      `const fs = require("node:fs");
      module.exports = { register(ctx) {
        ctx.events.on("host:runtime:ready", (payload) => {
          fs.writeFileSync(${JSON.stringify(marker)}, payload.phase);
        });
      } };`,
      "utf8",
    );
    const mgr = new PluginManager(h.options);
    await mgr.start();

    await mgr.publishHostEvent("runtime:ready", { phase: "core" });
    expect(readFileSync(marker, "utf8")).toBe("core");

    await mgr.setEnabled("demo", false);
    await mgr.publishHostEvent("runtime:ready", { phase: "background" });
    expect(readFileSync(marker, "utf8")).toBe("core");
  });

  it("普通宿主事件旁路发布，不等待监听器的未决 Promise", async () => {
    const h = harness();
    const marker = path.join(tmp, "slow-listener-entered");
    writeFileSync(
      path.join(tmp, "demo", "index.cjs"),
      `const fs = require("node:fs");
      module.exports = { register(ctx) {
        ctx.events.on("host:runtime:ready", () => {
          fs.writeFileSync(${JSON.stringify(marker)}, "entered");
          return new Promise(() => {});
        });
      } };`,
      "utf8",
    );
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const mgr = new PluginManager(h.options);
    await mgr.start();

    // 监听器返回永不兑现的 Promise：若发布路径等待监听器，这里会一直挂起
    await mgr.publishHostEvent("runtime:ready", { phase: "core" });

    expect(readFileSync(marker, "utf8")).toBe("entered");
  });

  it("在插件仍可接收时发布插件系统 ready 和 stopping 事件", async () => {
    const h = harness();
    const marker = path.join(tmp, "lifecycle-events");
    writeFileSync(
      path.join(tmp, "demo", "index.cjs"),
      `const fs = require("node:fs");
      module.exports = { register(ctx) {
        ctx.events.on("host:plugins:ready", () => fs.appendFileSync(${JSON.stringify(marker)}, "ready\\n"));
        ctx.events.on("host:plugins:stopping", () => fs.appendFileSync(${JSON.stringify(marker)}, "stopping\\n"));
      } };`,
      "utf8",
    );
    const mgr = new PluginManager(h.options);

    await mgr.start();
    await mgr.stop();

    expect(readFileSync(marker, "utf8")).toBe("ready\nstopping\n");
  });

  it("只允许打开已启用且声明 open 的插件", async () => {
    const h = harness();
    const mgr = new PluginManager(h.options);
    await mgr.start();

    expect(mgr.list()[0].canOpen).toBe(true);
    expect(h.ipc.has("plugins:open")).toBe(true);
    await expect(h.ipc.get("plugins:open")?.("demo")).resolves.toEqual({ ok: true });

    await mgr.setEnabled("demo", false);
    await expect(h.ipc.get("plugins:open")?.("demo")).resolves.toMatchObject({ ok: false });
  });

  it("开关关闭的插件不激活", async () => {
    const h = harness({
      loadEnabledMap: () => ({ demo: false }),
    });
    const mgr = new PluginManager(h.options);
    await mgr.start();
    expect(mgr.list()[0].enabled).toBe(false);
    expect(h.ipc.has("plugin:demo:ping")).toBe(false);
  });

  it("setEnabled(false) 清理资源并持久化；setEnabled(true) 重新激活", async () => {
    const h = harness();
    const mgr = new PluginManager(h.options);
    await mgr.start();
    expect(h.tools).toContain("demo_tool");

    const off = await mgr.setEnabled("demo", false);
    expect(off.ok).toBe(true);
    expect(mgr.list()[0].enabled).toBe(false);
    expect(h.ipc.has("plugin:demo:ping")).toBe(false);
    expect(h.tools).toEqual([]);
    expect(h.getEnabledMap().demo).toBe(false);

    const on = await mgr.setEnabled("demo", true);
    expect(on.ok).toBe(true);
    expect(h.ipc.has("plugin:demo:ping")).toBe(true);
    expect(h.tools).toContain("demo_tool");
  });

  it("重复 id 只保留第一个扫描结果", async () => {
    const h = harness();
    fixturePlugin("demo-copy", "demo");
    h.options.scanRoots = [{ path: path.dirname(fixturePlugin("demo")), source: "builtin" }];
    const mgr = new PluginManager(h.options);
    await mgr.start();
    expect(mgr.list()).toHaveLength(1);
  });

  it("setEnabled 未知 id 返回失败", async () => {
    const h = harness();
    const mgr = new PluginManager(h.options);
    await mgr.start();
    const res = await mgr.setEnabled("nope", true);
    expect(res.ok).toBe(false);
  });

  it("stop 清理插件资源和管理 IPC", async () => {
    const h = harness();
    const mgr = new PluginManager(h.options);
    await mgr.start();

    await mgr.stop();

    expect(mgr.list()).toEqual([]);
    expect(h.tools).toEqual([]);
    expect(h.ipc.size).toBe(0);
  });

  it("unregister 抛错时仍完成停用并持久化状态", async () => {
    const h = harness();
    writeFileSync(
      path.join(tmp, "demo", "index.cjs"),
      `module.exports = { register(ctx) { ctx.registerIpc("ping", () => "pong"); }, unregister() { throw new Error("cleanup failed"); } };`,
      "utf8",
    );
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const mgr = new PluginManager(h.options);
    await mgr.start();

    const result = await mgr.setEnabled("demo", false);

    expect(result).toEqual({ ok: true });
    expect(mgr.list()[0].enabled).toBe(false);
    expect(h.ipc.has("plugin:demo:ping")).toBe(false);
    expect(h.getEnabledMap().demo).toBe(false);
  });

  it("unregister 超时后仍释放框架资源并完成停用", async () => {
    const h = harness();
    writeFileSync(
      path.join(tmp, "demo", "index.cjs"),
      `module.exports = {
        register(ctx) { ctx.registerIpc("ping", () => "pong"); },
        unregister() { return new Promise(() => {}); }
      };`,
      "utf8",
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const mgr = new PluginManager(h.options);
    await mgr.start();
    vi.useFakeTimers();

    const disabling = mgr.setEnabled("demo", false);
    await vi.advanceTimersByTimeAsync(PLUGIN_CLEANUP_TIMEOUT_MS);
    const result = await disabling;

    expect(result).toEqual({ ok: true });
    expect(mgr.list()[0].enabled).toBe(false);
    expect(h.ipc.has("plugin:demo:ping")).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      "[plugins] 插件 demo unregister 失败，继续释放框架资源",
      expect.objectContaining({ message: expect.stringContaining("unregister 清理超时") }),
    );
  });

  it("停用时在 unregister 前取消插件 signal", async () => {
    const h = harness();
    const marker = path.join(tmp, "signal-state");
    writeFileSync(
      path.join(tmp, "demo", "index.cjs"),
      `const fs = require("node:fs");
      let context;
      module.exports = {
        register(ctx) { context = ctx; },
        unregister() { fs.writeFileSync(${JSON.stringify(marker)}, String(context.signal.aborted)); }
      };`,
      "utf8",
    );
    const mgr = new PluginManager(h.options);
    await mgr.start();

    await mgr.setEnabled("demo", false);

    expect(readFileSync(marker, "utf8")).toBe("true");
  });

  it("setEnabled(false) 会执行插件登记的 onDispose 回调", async () => {
    const h = harness();
    const marker = path.join(tmp, "dispose-called");
    writeFileSync(
      path.join(tmp, "demo", "index.cjs"),
      `const fs = require("node:fs");
      module.exports = {
        register(ctx) {
          ctx.onDispose(() => fs.writeFileSync(${JSON.stringify(marker)}, "yes"));
        }
      };`,
      "utf8",
    );
    const mgr = new PluginManager(h.options);
    await mgr.start();

    await mgr.setEnabled("demo", false);

    expect(readFileSync(marker, "utf8")).toBe("yes");
  });

  it("setEnabled(false) 会移除插件提示词 Provider", async () => {
    const h = harness();
    writeFileSync(
      path.join(tmp, "demo", "index.cjs"),
      `module.exports = { register(ctx) {
        ctx.registerPromptProvider({ id: "context", provide: ({ userText }) => "插件看到：" + userText });
      } };`,
      "utf8",
    );
    const mgr = new PluginManager(h.options);
    await mgr.start();

    expect(await h.promptRegistry.build({
      source: "conversation",
      mode: "chat",
      userText: "你好",
    })).toContain("插件看到：你好");

    await mgr.setEnabled("demo", false);
    expect(await h.promptRegistry.build({
      source: "conversation",
      mode: "chat",
      userText: "你好",
    })).toBe("");
  });

  it("启动失败后保留 desired state 和错误；修复入口后可重试", async () => {
    const h = harness();
    writeFileSync(
      path.join(tmp, "demo", "index.cjs"),
      `let attempts = 0;
      module.exports = { register(ctx) {
        attempts += 1;
        if (attempts === 1) throw new Error("first start failed");
        ctx.registerIpc("ping", () => "pong");
      } };`,
      "utf8",
    );
    vi.spyOn(console, "error").mockImplementation(() => {});
    const mgr = new PluginManager(h.options);

    await mgr.start();
    expect(mgr.list()[0].enabled).toBe(false);
    expect(mgr.list()[0]).toMatchObject({
      configuredEnabled: true,
      status: "failed",
      error: "first start failed",
    });

    writeFileSync(
      path.join(tmp, "demo", "index.cjs"),
      `module.exports = { register(ctx) { ctx.registerIpc("ping", () => "pong"); } };`,
      "utf8",
    );

    const retried = await mgr.setEnabled("demo", true);
    expect(retried.ok).toBe(true);
    expect(mgr.list()[0].enabled).toBe(true);
    expect(h.ipc.has("plugin:demo:ping")).toBe(true);
  });

  it("register 失败时调用插件 unregister 回滚，再释放宿主资源", async () => {
    const h = harness();
    const rollbackMarker = path.join(tmp, "rollback-called");
    writeFileSync(
      path.join(tmp, "demo", "index.cjs"),
      `const fs = require("node:fs");
      let context;
      module.exports = {
        register(ctx) {
          context = ctx;
          ctx.registerIpc("partial", () => "leaked");
          throw new Error("partial activation failed");
        },
        unregister() { fs.writeFileSync(${JSON.stringify(rollbackMarker)}, String(context.signal.aborted)); }
      };`,
      "utf8",
    );
    vi.spyOn(console, "error").mockImplementation(() => {});

    const mgr = new PluginManager(h.options);
    await mgr.start();

    expect(readFileSync(rollbackMarker, "utf8")).toBe("true");
    expect(h.ipc.has("plugin:demo:partial")).toBe(false);
    expect(mgr.list()[0]).toMatchObject({
      configuredEnabled: true,
      enabled: false,
      status: "failed",
      error: "partial activation failed",
    });
  });

  it("用户插件首次发现时忽略作者的 defaultEnabled，等待用户确认", async () => {
    const h = harness();
    h.options.scanRoots = [{ path: path.dirname(fixturePlugin("demo")), source: "user" }];
    const mgr = new PluginManager(h.options);
    await mgr.start();
    expect(mgr.list()[0]).toMatchObject({
      source: "user",
      configuredEnabled: false,
      status: "disabled",
    });
    expect(h.tools).toEqual([]);
  });

  it("通过导入 IPC 安装用户插件、重扫并保持首次停用", async () => {
    const h = harness();
    const userRoot = path.join(tmp, "user-plugins");
    h.options.scanRoots.push({ path: userRoot, source: "user" });
    h.options.selectPluginZip = async () => path.join(tmp, "plugin.zip");
    const stagingDir = path.join(userRoot, ".staging");
    const pluginDir = path.join(stagingDir, "package");
    const importedManifest = {
      apiVersion: 1 as const,
      id: "zip-demo",
      name: "ZIP Demo",
      version: "1.0.0",
      description: "d",
      author: "a",
      entry: "index.cjs",
      defaultEnabled: true,
    };
    vi.spyOn(installer, "preparePluginZip").mockResolvedValue({
      stagingDir,
      pluginDir,
      manifest: importedManifest,
    });
    vi.spyOn(installer, "commitPreparedPlugin").mockImplementation(async () => {
      const destination = path.join(userRoot, "zip-demo");
      mkdirSync(destination, { recursive: true });
      writeFileSync(path.join(destination, "manifest.json"), JSON.stringify(importedManifest));
      writeFileSync(path.join(destination, "index.cjs"), "module.exports={register(){}}");
      return destination;
    });
    const mgr = new PluginManager(h.options);
    await mgr.start();

    const result = await h.ipc.get("plugins:import-zip")?.();

    expect(result).toMatchObject({ ok: true, plugin: { id: "zip-demo" } });
    expect(mgr.list()).toContainEqual(expect.objectContaining({
      id: "zip-demo",
      source: "user",
      configuredEnabled: false,
      status: "disabled",
    }));
    expect(h.tools).not.toContain("zip-demo_tool");
  });

  it("卸载用户插件时先清理运行资源，再删除目录、启停记录并重扫", async () => {
    const h = harness({ loadEnabledMap: () => ({ demo: true }) });
    h.options.scanRoots = [{ path: path.dirname(fixturePlugin("demo")), source: "user" }];
    const pluginDir = path.join(tmp, "demo");
    const pluginDataDir = path.join(h.options.storageRoot, "demo");
    mkdirSync(pluginDataDir, { recursive: true });
    writeFileSync(path.join(pluginDataDir, "settings.json"), "{}", "utf8");
    const mgr = new PluginManager(h.options);
    await mgr.start();
    expect(h.tools).toContain("demo_tool");

    const result = await mgr.uninstall("demo");

    expect(result.ok).toBe(true);
    expect(existsSync(pluginDir)).toBe(false);
    expect(existsSync(pluginDataDir)).toBe(true);
    expect(h.tools).toEqual([]);
    expect(h.ipc.has("plugin:demo:ping")).toBe(false);
    expect(h.getEnabledMap()).toEqual({});
    expect(mgr.list()).toEqual([]);
  });

  it("卸载时通过持久化资源清理钩子删除插件名下的定时任务", async () => {
    const cleaned: string[] = [];
    const h = harness({
      loadEnabledMap: () => ({ demo: true }),
      cleanupPersistentResources: async (pluginId) => {
        cleaned.push(pluginId);
      },
    });
    h.options.scanRoots = [{ path: path.dirname(fixturePlugin("demo")), source: "user" }];
    const mgr = new PluginManager(h.options);
    await mgr.start();

    const result = await mgr.uninstall("demo");

    expect(result.ok).toBe(true);
    expect(cleaned).toEqual(["demo"]);
    expect(existsSync(path.join(tmp, "demo"))).toBe(false);
  });

  it("插件任务清理失败时卸载中止并保留目录，避免留下孤儿任务", async () => {
    const h = harness({
      loadEnabledMap: () => ({ demo: true }),
      cleanupPersistentResources: async () => {
        throw new Error("task file locked");
      },
    });
    h.options.scanRoots = [{ path: path.dirname(fixturePlugin("demo")), source: "user" }];
    const pluginDir = path.join(tmp, "demo");
    const mgr = new PluginManager(h.options);
    await mgr.start();

    const result = await mgr.uninstall("demo");

    expect(result.ok).toBe(false);
    expect(result.error).toContain("卸载插件失败（目录未删除）");
    expect(existsSync(pluginDir)).toBe(true);
    expect(mgr.list()).toContainEqual(expect.objectContaining({ id: "demo" }));
  });

  it("拒绝卸载内置插件", async () => {
    const h = harness();
    const pluginDir = path.join(tmp, "demo");
    const mgr = new PluginManager(h.options);
    await mgr.start();

    const result = await mgr.uninstall("demo");

    expect(result).toEqual({ ok: false, error: "内置插件不能卸载: demo" });
    expect(existsSync(pluginDir)).toBe(true);
    expect(mgr.list()).toHaveLength(1);
  });

  it("用户插件记录不再位于配置的用户根目录时拒绝删除", async () => {
    const h = harness({ loadEnabledMap: () => ({ demo: true }) });
    const pluginDir = path.join(tmp, "demo");
    h.options.scanRoots = [{ path: path.dirname(pluginDir), source: "user" }];
    const mgr = new PluginManager(h.options);
    await mgr.start();
    h.options.scanRoots = [{ path: path.join(tmp, "different-root"), source: "user" }];

    const result = await mgr.uninstall("demo");

    expect(result.ok).toBe(false);
    expect(result.error).toContain("拒绝卸载不安全的插件路径");
    expect(existsSync(pluginDir)).toBe(true);
    expect(h.tools).toContain("demo_tool");
  });

  it("启停记录无法持久化时不删除用户插件目录", async () => {
    const h = harness({
      loadEnabledMap: () => ({ demo: true }),
      saveEnabledMap: () => { throw new Error("disk read-only"); },
    });
    const pluginDir = path.join(tmp, "demo");
    h.options.scanRoots = [{ path: path.dirname(pluginDir), source: "user" }];
    const mgr = new PluginManager(h.options);
    await mgr.start();

    const result = await mgr.uninstall("demo");

    expect(result.ok).toBe(false);
    expect(result.error).toContain("清理插件启停记录失败，未删除目录");
    expect(existsSync(pluginDir)).toBe(true);
    expect(h.tools).toEqual([]);
  });

  it("rescan 重新加载活动插件并清理删除的插件", async () => {
    const h = harness();
    const mgr = new PluginManager(h.options);
    await mgr.start();
    expect(h.ipc.get("plugin:demo:ping")?.()).toBe("pong");

    writeFileSync(
      path.join(tmp, "demo", "index.cjs"),
      `module.exports = { register(ctx) {
        ctx.registerIpc("ping", () => "v2");
        ctx.registerTool({ id: "demo_tool", name: "t", description: "d", enabled: true, inputSchema: { type: "object", properties: {}, required: [] }, execute: async () => "ok" });
      } };`,
      "utf8",
    );
    await mgr.rescan();
    expect(h.ipc.get("plugin:demo:ping")?.()).toBe("v2");
    expect(h.tools).toEqual(["demo_tool"]);

    rmSync(path.join(tmp, "demo"), { recursive: true, force: true });
    await mgr.rescan();
    expect(mgr.list()).toEqual([]);
    expect(h.tools).toEqual([]);
    expect(h.ipc.has("plugin:demo:ping")).toBe(false);
  });

  it("并发启用请求串行执行，不重复注册资源", async () => {
    const h = harness({ loadEnabledMap: () => ({ demo: false }) });
    const mgr = new PluginManager(h.options);
    await mgr.start();
    const [first, second] = await Promise.all([
      mgr.setEnabled("demo", true),
      mgr.setEnabled("demo", true),
    ]);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(h.tools).toEqual(["demo_tool"]);
  });

  it("扫描根目录不可读时保留应用可用并展示问题", async () => {
    const h = harness();
    const invalidRoot = path.join(tmp, "not-a-directory");
    writeFileSync(invalidRoot, "x", "utf8");
    h.options.scanRoots = [{ path: invalidRoot, source: "user" }];
    const mgr = new PluginManager(h.options);
    await expect(mgr.start()).resolves.toBeUndefined();
    expect(mgr.overview().plugins).toEqual([]);
    expect(mgr.overview().issues[0]?.message).toMatch(/无法扫描插件目录/);
  });

  it("getSettingsPanelDir：仅已启用且声明合法面板的插件返回目录", async () => {
    const h = harness(); // 先初始化 tmp 再建 fixture
    const panelPluginDir = path.join(tmp, "panel-plugin");
    mkdirSync(panelPluginDir, { recursive: true });
    writeFileSync(
      path.join(panelPluginDir, "manifest.json"),
      JSON.stringify({
        apiVersion: 1,
        id: "panel-plugin",
        name: "面板插件",
        version: "1.0.0",
        description: "d",
        author: "a",
        entry: "index.cjs",
        settingsPanel: "ui.html",
        defaultEnabled: true,
      }),
      "utf8",
    );
    writeFileSync(path.join(panelPluginDir, "index.cjs"), "module.exports = { register() {} };", "utf8");
    writeFileSync(path.join(panelPluginDir, "ui.html"), "<p>panel</p>", "utf8");

    // demo 未声明面板；panel-plugin 声明面板（builtin + defaultEnabled，默认启用）
    const mgr = new PluginManager(h.options);
    await mgr.start();
    expect(mgr.getSettingsPanelDir("demo")).toBeUndefined();
    expect(mgr.getSettingsPanelDir("panel-plugin")).toBe(panelPluginDir);
    expect(mgr.getSettingsPanelDir("nobody")).toBeUndefined();

    // 用户禁用后立即失效（协议层对应 404）
    await mgr.setEnabled("panel-plugin", false);
    expect(mgr.getSettingsPanelDir("panel-plugin")).toBeUndefined();
  });
});

describe("marketplace origin bookkeeping", () => {
  const importedManifest = {
    apiVersion: 1 as const,
    id: "zip-demo",
    name: "ZIP Demo",
    version: "1.0.0",
    description: "d",
    author: "a",
    entry: "index.cjs",
    defaultEnabled: true,
  };

  /** 伪造一个已通过 ZIP 校验的 staging 目录，让真实 commit 流程可执行 */
  function fakePrepared(userRoot: string, version = "1.0.0") {
    const stagingDir = path.join(userRoot, ".staging");
    const pluginDir = path.join(stagingDir, "package");
    mkdirSync(pluginDir, { recursive: true });
    const manifest = { ...importedManifest, version };
    writeFileSync(path.join(pluginDir, "manifest.json"), JSON.stringify(manifest));
    writeFileSync(path.join(pluginDir, "index.cjs"), "module.exports={register(){}}");
    return { stagingDir, pluginDir, manifest };
  }

  it("市场安装落来源记录，列表 origin 标记为 market", async () => {
    const h = harness();
    const userRoot = path.join(tmp, "user-plugins");
    h.options.scanRoots.push({ path: userRoot, source: "user" });
    const prepared = fakePrepared(userRoot);
    vi.spyOn(installer, "preparePluginZip").mockResolvedValue(prepared);
    const mgr = new PluginManager(h.options);
    await mgr.start();

    const result = await mgr.installZip(path.join(tmp, "plugin.zip"), {
      origin: "market",
      expectedIdentity: { id: "zip-demo", version: "1.0.0" },
    });

    expect(result.ok).toBe(true);
    expect(mgr.list().find((e) => e.id === "zip-demo")?.origin).toBe("market");
  });

  it("本地 ZIP 覆盖市场安装的同 id 插件后，origin 回到 local", async () => {
    const h = harness();
    const userRoot = path.join(tmp, "user-plugins");
    h.options.scanRoots.push({ path: userRoot, source: "user" });
    h.options.confirmPluginReplace = async () => true;
    const first = fakePrepared(userRoot, "1.0.0");
    vi.spyOn(installer, "preparePluginZip").mockResolvedValueOnce(first);
    const mgr = new PluginManager(h.options);
    await mgr.start();
    await mgr.installZip(path.join(tmp, "plugin.zip"), { origin: "market" });

    const second = fakePrepared(userRoot, "2.0.0");
    vi.spyOn(installer, "preparePluginZip").mockResolvedValueOnce(second);
    const localResult = await mgr.installZip(path.join(tmp, "plugin.zip"));

    expect(localResult.ok).toBe(true);
    expect(mgr.list().find((e) => e.id === "zip-demo")?.origin).toBe("local");
  });

  it("卸载市场安装的插件时同步清除来源记录", async () => {
    const h = harness();
    const userRoot = path.join(tmp, "user-plugins");
    h.options.scanRoots.push({ path: userRoot, source: "user" });
    const prepared = fakePrepared(userRoot);
    vi.spyOn(installer, "preparePluginZip").mockResolvedValue(prepared);
    const mgr = new PluginManager(h.options);
    await mgr.start();
    await mgr.installZip(path.join(tmp, "plugin.zip"), { origin: "market" });

    const result = await mgr.uninstall("zip-demo");

    expect(result.ok).toBe(true);
    expect(installer.readHostMetadataSync(userRoot, "zip-demo")).toBeUndefined();
  });
});
