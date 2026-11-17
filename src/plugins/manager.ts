import path from "node:path";
import { lstat, realpath, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { IPC } from "../shared/ipc-channels";
import type {
  PluginListEntry,
  PluginOverview,
  PluginRuntimeStatus,
} from "../shared/plugin-management";
import { createContext, runPluginCleanup, type PluginRuntime } from "./context";
import { createPluginEventBus, qualifyHostEvent } from "./events";
import {
  clearPluginModuleCache,
  loadPlugin,
  scanPluginDir,
  type PluginScanIssue,
} from "./loader";
import {
  commitPreparedPlugin,
  discardPreparedPlugin,
  preparePluginZip,
  readHostMetadataSync,
  removeHostMetadata,
} from "./installer";
import type {
  CyrenePlugin,
  PluginContext,
  PluginRecord,
  PluginSource,
} from "./types";

export type { PluginListEntry, PluginOverview, PluginRuntimeStatus } from "../shared/plugin-management";

export interface PluginScanRoot {
  path: string;
  source: PluginSource;
}

export interface PluginManagerOptions {
  scanRoots: PluginScanRoot[];
  /** Plugin-private data root (userData/plugin-data). */
  storageRoot: string;
  runtime: PluginRuntime;
  loadEnabledMap: () => Record<string, boolean>;
  saveEnabledMap: (map: Record<string, boolean>) => void;
  selectPluginZip?: () => Promise<string | undefined>;
  confirmPluginReplace?: (plugin: { id: string; name: string; version: string }) => Promise<boolean>;
  /**
   * 用户真正卸载插件时清理其拥有的持久化宿主资源（如插件创建的定时任务）。
   * 抛错会中止卸载：宁可保留插件目录等用户重试，也不能留下仍会执行的孤儿任务。
   * 热重载、扫描更新、启停和安装替换都不调用。
   */
  cleanupPersistentResources?: (pluginId: string) => Promise<void>;
  onListChanged?: () => void;
}

export interface PluginImportResult {
  ok: boolean;
  canceled?: boolean;
  error?: string;
  plugin?: { id: string; name: string; version: string };
  overview?: PluginOverview;
}

type DisposableContext = PluginContext & {
  beginStop(): void;
  dispose(): Promise<void>;
};

const ICON_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
};

/** 读取插件图标为 data URL；manifest 未声明或读取失败返回 undefined。 */
function readIconDataUrl(record: PluginRecord): string | undefined {
  const icon = record.manifest.icon;
  if (!icon) return undefined;
  try {
    const ext = path.extname(icon).toLowerCase();
    const mime = ICON_MIME[ext];
    if (!mime) return undefined;
    const buf = readFileSync(path.join(record.dir, icon));
    return `data:${mime};base64,${buf.toString("base64")}`;
  } catch {
    return undefined;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class PluginManager {
  private readonly eventBus = createPluginEventBus();
  private records = new Map<string, PluginRecord>();
  private instances = new Map<string, CyrenePlugin>();
  private contexts = new Map<string, DisposableContext>();
  private statuses = new Map<string, PluginRuntimeStatus>();
  private errors = new Map<string, string>();
  private scanIssues: PluginScanIssue[] = [];
  private enabledMap: Record<string, boolean>;
  private started = false;
  private startupActivations = new Map<string, Promise<void>>();

  private startupDiscovery: Promise<void> = Promise.resolve();

  async waitForStartupTools(select: (pluginId: string) => boolean): Promise<void> {
    await this.startupDiscovery;
    await Promise.all([...this.startupActivations].filter(([id]) => select(id)).map(([, task]) => task));
  }
  /** 宿主模块订阅的插件运行状态监听器（调度引擎等）。 */
  private runningStateListeners = new Set<(pluginId: string, running: boolean) => void>();
  /** All lifecycle mutations are serialized to prevent enable/disable/rescan races. */
  private operationTail: Promise<void> = Promise.resolve();

  constructor(private opts: PluginManagerOptions) {
    this.enabledMap = opts.loadEnabledMap() ?? {};
  }

  list(): PluginListEntry[] {
    const userRoot = this.opts.scanRoots.find((root) => root.source === "user")?.path;
    return Array.from(this.records.values())
      .map((record) => {
        const id = record.manifest.id;
        const plugin = this.instances.get(id);
        const status = this.statuses.get(id) ?? "disabled";
        // 来源以宿主侧安装记录为准：有市场记录即为 market，否则视为本地（含内置）
        const origin = userRoot && record.source === "user" && readHostMetadataSync(userRoot, id)
          ? "market" as const
          : "local" as const;
        return {
          id,
          name: record.manifest.name,
          version: record.manifest.version,
          description: record.manifest.description,
          author: record.manifest.author,
          entry: record.manifest.entry,
          apiVersion: record.manifest.apiVersion,
          source: record.source,
          origin,
          path: record.dir,
          defaultEnabled: record.manifest.defaultEnabled,
          configuredEnabled: this.isConfiguredEnabled(record),
          enabled: status === "running",
          status,
          error: this.errors.get(id),
          hasUnregister: typeof plugin?.unregister === "function",
          canOpen: typeof plugin?.open === "function",
          icon: readIconDataUrl(record),
          // 面板字段仅对已启用插件透出（渲染端不挂载禁用插件的面板）
          settingsPanel: this.isConfiguredEnabled(record) ? record.manifest.settingsPanel : undefined,
          settingsSection: this.isConfiguredEnabled(record) ? record.manifest.settingsSection : undefined,
        };
      })
      .sort((a, b) => {
        if (a.source !== b.source) return a.source === "builtin" ? -1 : 1;
        return a.name.localeCompare(b.name, "zh-CN");
      });
  }

  overview(): PluginOverview {
    return { plugins: this.list(), issues: [...this.scanIssues] };
  }

  /**
   * 设置面板协议的访问查询：仅「已启用且声明了合法 settingsPanel」的插件
   * 返回其目录，禁用或未声明面板的插件返回 undefined（协议层对应 404）。
   */
  getSettingsPanelDir(pluginId: string): string | undefined {
    const record = this.records.get(pluginId);
    if (!record?.manifest.settingsPanel) return undefined;
    if (!this.isConfiguredEnabled(record)) return undefined;
    return record.dir;
  }

  /**
   * 发布普通宿主事件（旁路）：监听器在后续宏任务中派发，发布方不等待任何第三方监听器。
   * 单个监听器同步抛错或异步失败只记录日志，不影响其余监听器。
   */
  publishHostEvent<T = unknown>(event: string, payload: T): Promise<void> {
    return this.eventBus.emit(qualifyHostEvent(event), payload);
  }

  /**
   * 发布插件系统启动/停止屏障事件：顺序等待每个监听器完成（含单个超时）后才返回。
   * 仅用于 plugins:ready / plugins:stopping，其余宿主事件必须走旁路发布。
   */
  publishHostLifecycleBarrier<T = unknown>(event: string, payload: T): Promise<void> {
    return this.eventBus.emitLifecycleBarrier(qualifyHostEvent(event), payload);
  }

  /** 插件当前是否处于运行状态（已完成注册激活）。 */
  isRunning(pluginId: string): boolean {
    return this.instances.has(pluginId);
  }

  /**
   * 订阅插件运行状态变化（激活完成 → running，停用完成 → 非 running）。
   * 调度引擎据此暂停/恢复插件任务；单个监听器失败只告警不中断。
   */
  onRunningStateChange(listener: (pluginId: string, running: boolean) => void): () => void {
    this.runningStateListeners.add(listener);
    return () => { this.runningStateListeners.delete(listener); };
  }

  private notifyRunningState(pluginId: string, running: boolean): void {
    for (const listener of this.runningStateListeners) {
      try {
        listener(pluginId, running);
      } catch (error) {
        console.warn(`[plugins] 运行状态监听器执行失败 (${pluginId})`, error);
      }
    }
  }

  start(activateAfter: Promise<void> = Promise.resolve()): Promise<void> {
    let discovered!: () => void;
    this.startupDiscovery = new Promise<void>((resolve) => { discovered = resolve; });
    return this.enqueueOperation(async () => {
      if (this.started) return;
      this.started = true;
      this.opts.runtime.registerIpc(IPC.PLUGINS_LIST, () => this.overview());
      this.opts.runtime.registerIpc(
        IPC.PLUGINS_SET_ENABLED,
        async (id: unknown, enabled: unknown) => {
          if (typeof id !== "string" || !id) {
            return { ok: false, error: "id 必须是非空字符串" };
          }
          if (typeof enabled !== "boolean") {
            return { ok: false, error: "enabled 必须是布尔值" };
          }
          return this.setEnabled(id, enabled);
        },
      );
      this.opts.runtime.registerIpc(IPC.PLUGINS_OPEN, (id: unknown) => {
        if (typeof id !== "string" || !id) {
          return { ok: false, error: "id 必须是非空字符串" };
        }
        return this.open(id);
      });
      this.opts.runtime.registerIpc(IPC.PLUGINS_RESCAN, () => this.rescan());
      this.opts.runtime.registerIpc(IPC.PLUGINS_IMPORT_ZIP, async () => {
        if (!this.opts.selectPluginZip) return { ok: false, error: "当前环境不支持选择 ZIP 文件" };
        const zipPath = await this.opts.selectPluginZip();
        if (!zipPath) return { ok: false, canceled: true };
        return this.installZip(zipPath);
      });
      this.opts.runtime.registerIpc(IPC.PLUGINS_UNINSTALL, (id: unknown) => {
        if (typeof id !== "string" || !id) {
          return { ok: false, error: "id 必须是非空字符串" };
        }
        return this.uninstall(id);
      });
      await activateAfter;
      const activating = this.doRescan(false, true);
      discovered();
      await activating;
      await this.publishHostLifecycleBarrier("plugins:ready", {
        pluginIds: this.list().filter((plugin) => plugin.enabled).map((plugin) => plugin.id),
      });
      this.opts.onListChanged?.();
    }).finally(discovered);
  }

  rescan(): Promise<PluginOverview> {
    return this.enqueueOperation(async () => {
      await this.doRescan(true);
      this.opts.onListChanged?.();
      return this.overview();
    });
  }

  setEnabled(
    id: string,
    enabled: boolean,
  ): Promise<{ ok: boolean; error?: string }> {
    return this.enqueueOperation(async () => {
      const record = this.records.get(id);
      if (!record) return { ok: false, error: `插件不存在: ${id}` };

      this.enabledMap[id] = enabled;
      try {
        this.opts.saveEnabledMap({ ...this.enabledMap });
      } catch (error) {
        return { ok: false, error: `保存插件开关失败: ${errorMessage(error)}` };
      }

      if (!enabled) {
        await this.deactivate(id);
        this.statuses.set(id, "disabled");
        this.errors.delete(id);
        this.opts.onListChanged?.();
        return { ok: true };
      }

      if (this.instances.has(id)) {
        this.statuses.set(id, "running");
        this.errors.delete(id);
        return { ok: true };
      }
      try {
        await this.activate(id);
        this.opts.onListChanged?.();
        return { ok: true };
      } catch (error) {
        const message = errorMessage(error);
        this.statuses.set(id, "failed");
        this.errors.set(id, message);
        this.opts.onListChanged?.();
        return { ok: false, error: message };
      }
    });
  }

  open(id: string): Promise<{ ok: boolean; error?: string }> {
    return this.enqueueOperation(async () => {
      const plugin = this.instances.get(id);
      if (!plugin) return { ok: false, error: `插件未运行: ${id}` };
      if (!plugin.open) return { ok: false, error: `插件不支持打开窗口: ${id}` };
      try {
        await plugin.open();
        return { ok: true };
      } catch (error) {
        return { ok: false, error: errorMessage(error) };
      }
    });
  }

  installZip(
    zipPath: string,
    opts: {
      /** 市场安装时传入：校验插件包身份与市场登记一致，并落市场来源记录 */
      expectedIdentity?: { id: string; version: string };
      origin?: "market";
      registryId?: string;
    } = {},
  ): Promise<PluginImportResult> {
    return this.enqueueOperation(async () => {
      const userRoot = this.opts.scanRoots.find((root) => root.source === "user")?.path;
      if (!userRoot) return { ok: false, error: "未配置用户插件目录" };

      let prepared;
      try {
        prepared = await preparePluginZip(zipPath, userRoot, {
          expectedIdentity: opts.expectedIdentity,
        });
      } catch (error) {
        return { ok: false, error: `插件包校验失败: ${errorMessage(error)}` };
      }

      const plugin = {
        id: prepared.manifest.id,
        name: prepared.manifest.name,
        version: prepared.manifest.version,
      };
      const existingRecord = this.records.get(plugin.id);
      if (existingRecord?.source === "builtin") {
        await discardPreparedPlugin(prepared);
        return { ok: false, error: `不能用用户插件覆盖内置插件: ${plugin.id}` };
      }

      const destination = path.join(userRoot, plugin.id);
      const replacing = await lstat(destination).then(() => true, () => false);
      if (replacing) {
        let confirmed = false;
        try {
          confirmed = await this.opts.confirmPluginReplace?.(plugin) ?? false;
        } catch (error) {
          await discardPreparedPlugin(prepared);
          return { ok: false, error: `无法确认是否替换插件: ${errorMessage(error)}` };
        }
        if (!confirmed) {
          await discardPreparedPlugin(prepared);
          return { ok: false, canceled: true, plugin };
        }
      }

      if (existingRecord?.source === "user") await this.deactivate(plugin.id);
      if (!existingRecord) {
        const nextEnabledMap = { ...this.enabledMap };
        delete nextEnabledMap[plugin.id];
        try {
          this.opts.saveEnabledMap(nextEnabledMap);
          this.enabledMap = nextEnabledMap;
        } catch (error) {
          await discardPreparedPlugin(prepared);
          return { ok: false, error: `初始化插件停用状态失败，未安装: ${errorMessage(error)}` };
        }
      }

      try {
        await commitPreparedPlugin(prepared, userRoot, replacing, {
          marketOrigin: opts.origin === "market"
            ? { registryId: opts.registryId ?? "cyrene-official" }
            : undefined,
        });
      } catch (error) {
        await this.doRescan(false);
        this.opts.onListChanged?.();
        return { ok: false, error: `安装插件失败: ${errorMessage(error)}` };
      }
      if (opts.origin !== "market") {
        // 本地 ZIP 覆盖了市场安装的同 id 插件：清除市场来源记录
        try {
          await removeHostMetadata(userRoot, plugin.id);
        } catch (error) {
          console.warn(`[plugins] 清理插件 ${plugin.id} 市场来源记录失败:`, error);
        }
      }

      await this.doRescan(false);
      this.opts.onListChanged?.();
      return { ok: true, plugin, overview: this.overview() };
    });
  }

  uninstall(id: string): Promise<{ ok: boolean; error?: string; overview?: PluginOverview }> {
    return this.enqueueOperation(async () => {
      const record = this.records.get(id);
      if (!record) return { ok: false, error: `插件不存在: ${id}` };
      if (record.source !== "user") {
        return { ok: false, error: `内置插件不能卸载: ${id}` };
      }
      const userRoot = this.opts.scanRoots.find((root) => root.source === "user")?.path;
      if (!userRoot) return { ok: false, error: "未配置用户插件目录" };

      try {
        await this.assertSafeUserPluginDirectory(record);
      } catch (error) {
        return { ok: false, error: `拒绝卸载不安全的插件路径: ${errorMessage(error)}` };
      }

      await this.deactivate(id);

      // 先持久化“未启用”语义。即使随后目录删除失败，下一次扫描也不会自动重启插件。
      const nextEnabledMap = { ...this.enabledMap };
      delete nextEnabledMap[id];
      try {
        this.opts.saveEnabledMap(nextEnabledMap);
        this.enabledMap = nextEnabledMap;
      } catch (error) {
        const message = `清理插件启停记录失败，未删除目录: ${errorMessage(error)}`;
        this.statuses.set(id, "failed");
        this.errors.set(id, message);
        this.opts.onListChanged?.();
        return { ok: false, error: message };
      }

      try {
        // unregister() 属于第三方代码，执行后再次校验，避免它在清理阶段替换目标目录。
        await this.assertSafeUserPluginDirectory(record);
        await this.opts.cleanupPersistentResources?.(id);
        clearPluginModuleCache(record.dir);
        await rm(record.dir, { recursive: true, force: false });
      } catch (error) {
        // 任务清理失败与目录删除失败同一处理：插件保持停用、目录保留，
        // 避免出现"程序已删、定时任务还在跑"的孤儿状态。
        const message = `卸载插件失败（目录未删除）: ${errorMessage(error)}`;
        this.statuses.set(id, "disabled");
        this.errors.set(id, message);
        this.opts.onListChanged?.();
        return { ok: false, error: message };
      }

      try {
        await removeHostMetadata(userRoot, id);
      } catch (error) {
        console.warn(`[plugins] 清理插件 ${id} 市场来源记录失败:`, error);
      }

      await this.doRescan(false);
      this.opts.onListChanged?.();
      return { ok: true, overview: this.overview() };
    });
  }

  stop(): Promise<void> {
    return this.enqueueOperation(async () => {
      if (!this.started) return;
      await this.publishHostLifecycleBarrier("plugins:stopping", undefined);
      for (const id of Array.from(this.instances.keys())) {
        await this.deactivate(id);
      }
      for (const channel of [
        IPC.PLUGINS_LIST,
        IPC.PLUGINS_SET_ENABLED,
        IPC.PLUGINS_OPEN,
        IPC.PLUGINS_RESCAN,
        IPC.PLUGINS_IMPORT_ZIP,
        IPC.PLUGINS_UNINSTALL,
      ]) {
        try {
          this.opts.runtime.unregisterIpc(channel);
        } catch (error) {
          console.warn(`[plugins] 管理通道 ${channel} 清理失败`, error);
        }
      }
      this.records.clear();
      this.statuses.clear();
      this.errors.clear();
      this.scanIssues = [];
      this.eventBus.clear();
      this.started = false;
    });
  }

  private enqueueOperation<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.operationTail.then(operation, operation);
    this.operationTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private isConfiguredEnabled(record: PluginRecord): boolean {
    if (Object.prototype.hasOwnProperty.call(this.enabledMap, record.manifest.id)) {
      return this.enabledMap[record.manifest.id] === true;
    }
    // User-installed code is never executed on first discovery without opt-in.
    return record.source === "builtin" && record.manifest.defaultEnabled;
  }

  private async assertSafeUserPluginDirectory(record: PluginRecord): Promise<void> {
    const candidateRoot = this.opts.scanRoots.find((root) => {
      if (root.source !== "user") return false;
      const relative = path.relative(path.resolve(root.path), path.resolve(record.dir));
      return relative.length > 0
        && !relative.startsWith("..")
        && !path.isAbsolute(relative)
        && !relative.includes(path.sep);
    });
    if (!candidateRoot) throw new Error("插件目录不是用户插件根目录的一级子目录");

    const stat = await lstat(record.dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error("插件路径不是普通目录");
    }

    const [rootReal, pluginReal] = await Promise.all([
      realpath(candidateRoot.path),
      realpath(record.dir),
    ]);
    const relative = path.relative(rootReal, pluginReal);
    if (
      relative.length === 0
      || relative.startsWith("..")
      || path.isAbsolute(relative)
      || relative.includes(path.sep)
    ) {
      throw new Error("插件真实路径不在用户插件根目录的一级范围内");
    }
  }

  private scanAll(): {
    records: Map<string, PluginRecord>;
    issues: PluginScanIssue[];
    failedRoots: Set<string>;
  } {
    const records = new Map<string, PluginRecord>();
    const issues: PluginScanIssue[] = [];
    const failedRoots = new Set<string>();
    for (const root of this.opts.scanRoots) {
      const onIssue = (issue: PluginScanIssue): void => {
        issues.push(issue);
        if (!issue.path) failedRoots.add(root.path);
      };
      for (const record of scanPluginDir(root.path, root.source, onIssue)) {
        const existing = records.get(record.manifest.id);
        if (existing) {
          const issue: PluginScanIssue = {
            root: root.path,
            path: record.dir,
            source: root.source,
            message: `插件 id 重复，已保留 ${existing.dir}`,
          };
          issues.push(issue);
          console.warn(`[plugins] ${issue.message}，忽略 ${record.dir}`);
          continue;
        }
        records.set(record.manifest.id, record);
      }
    }
    return { records, issues, failedRoots };
  }

  private async doRescan(reloadActive: boolean, startup = false): Promise<void> {
    const scanned = this.scanAll();
    const previousRecords = this.records;
    // A transient root-level read error must not unload already-running plugins.
    for (const previous of previousRecords.values()) {
      const failedRoot = this.opts.scanRoots.find(
        (root) => scanned.failedRoots.has(root.path) && previous.source === root.source,
      );
      if (failedRoot && !scanned.records.has(previous.manifest.id)) {
        scanned.records.set(previous.manifest.id, previous);
      }
    }
    const activeBefore = new Set(this.instances.keys());

    for (const id of activeBefore) {
      const before = previousRecords.get(id);
      const after = scanned.records.get(id);
      const changed = !before
        || !after
        || before.dir !== after.dir
        || before.fingerprint !== after.fingerprint;
      if (reloadActive || changed) await this.deactivate(id);
    }

    this.records = scanned.records;
    this.scanIssues = scanned.issues;

    for (const id of Array.from(this.statuses.keys())) {
      if (!this.records.has(id)) {
        this.statuses.delete(id);
        this.errors.delete(id);
      }
    }

    for (const [id, record] of this.records) {
      if (this.instances.has(id)) {
        this.statuses.set(id, "running");
        continue;
      }
      if (!this.isConfiguredEnabled(record)) {
        this.statuses.set(id, "disabled");
        this.errors.delete(id);
        continue;
      }
      const activating = this.activate(id).catch((error) => {
        console.error(`[plugins] 插件 ${id} 启用失败，跳过`, error);
      });
      if (startup) this.startupActivations.set(id, activating);
      else await activating;
    }
    if (startup) {
      await Promise.all(this.startupActivations.values());
      this.startupActivations.clear();
    }
  }

  private async activate(id: string): Promise<void> {
    const record = this.records.get(id);
    if (!record || this.instances.has(id)) return;
    this.statuses.set(id, "starting");
    this.errors.delete(id);
    try {
      const plugin = await loadPlugin(record);
      const ctx = createContext(
        id,
        path.join(this.opts.storageRoot, id),
        this.opts.runtime,
        this.eventBus,
        record.manifest.deps,
      );
      try {
        await plugin.register(ctx);
      } catch (error) {
        ctx.beginStop();
        if (plugin.unregister) {
          try {
            await runPluginCleanup(() => plugin.unregister!(), `插件 ${id} unregister`);
          } catch (cleanupError) {
            console.warn(`[plugins] 插件 ${id} 激活回滚时 unregister 失败`, cleanupError);
          }
        }
        await ctx.dispose();
        throw error;
      }
      this.instances.set(id, plugin);
      this.contexts.set(id, ctx);
      this.statuses.set(id, "running");
      this.notifyRunningState(id, true);
      console.log(`[plugins] 已启用 ${id}@${record.manifest.version}`);
    } catch (error) {
      const message = errorMessage(error);
      this.statuses.set(id, "failed");
      this.errors.set(id, message);
      throw error;
    }
  }

  private async deactivate(id: string): Promise<void> {
    const plugin = this.instances.get(id);
    const context = this.contexts.get(id);
    if (!plugin && !context) return;
    this.statuses.set(id, "stopping");
    context?.beginStop();
    try {
      if (plugin?.unregister) {
        try {
          await runPluginCleanup(() => plugin.unregister!(), `插件 ${id} unregister`);
        } catch (error) {
          console.warn(`[plugins] 插件 ${id} unregister 失败，继续释放框架资源`, error);
        }
      }
    } finally {
      try {
        await context?.dispose();
      } finally {
        this.instances.delete(id);
        this.contexts.delete(id);
      }
    }
    this.statuses.set(id, "disabled");
    this.notifyRunningState(id, false);
    console.log(`[plugins] 已禁用 ${id}`);
  }
}
