import type { PluginEventBus } from "./events";
import { qualifyPluginEvent } from "./events";
import { createPluginStorage } from "./storage";
import type {
  PluginChannelAdapter,
  PluginContext,
  PluginDeps,
  PluginLlmService,
  PluginManifest,
  PluginPromptProvider,
  PluginTool,
} from "./types";
import type { PluginPromptRegistry } from "./prompts";
import type { PluginResourceTracker } from "./resources";
import { createPluginResourceTracker } from "./resources";

export { PLUGIN_CLEANUP_TIMEOUT_MS, runPluginCleanup } from "./cleanup";

const IPC_SEGMENT_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

/** deps 声明名到 PluginDeps 字段名的映射（连字符能力名转驼峰）。 */
const DEP_TO_FIELD: Record<string, keyof PluginDeps> = {
  channels: "channels",
  llm: "llm",
  secrets: "secrets",
  workspace: "workspace",
  conversations: "conversations",
  scheduler: "scheduler",
  "speech-input": "speechInput",
};

/**
 * 宿主服务工厂：为每个插件生成一份可用服务集合，不保存共享实例。
 * 服务如需登记可回收资源（例如语音租约），应通过 trackResource 进入
 * 该插件的资源跟踪器，与框架资源共用同一条清理路径。
 */
export interface PluginHostServiceFactory {
  createForPlugin(input: {
    pluginId: string;
    signal: AbortSignal;
    trackResource: PluginResourceTracker;
  }): PluginDeps;
}

export interface PluginRuntime {
  /** 宿主工具注册表端口；宿主实现负责把 PluginTool 适配进自己的注册体系。 */
  toolRegistry: {
    register(tool: PluginTool): void;
    unregister(id: string): boolean;
    /** 供冲突告警使用；不存在时跳过 */
    getById?(id: string): { id: string } | undefined;
  };
  /** 宿主渠道管理器端口；宿主实现负责适配 ChannelAdapter。 */
  channelManager: {
    has(id: string): boolean;
    register(adapter: PluginChannelAdapter): void;
    unregister(id: string): Promise<boolean>;
    startOne(id: string): Promise<void>;
  };
  registerIpc: (channel: string, handler: (...args: unknown[]) => unknown) => void;
  unregisterIpc: (channel: string) => void;
  promptRegistry: Pick<PluginPromptRegistry, "register" | "unregister">;
  /** 宿主服务工厂；新宿主服务只允许从这里注入，不再向 PluginContext 增加特例。 */
  hostServices?: PluginHostServiceFactory;
  /** 未提供工厂时的兼容入口：宿主基础 LLM 服务（由框架包装 purpose 前缀）。 */
  llm?: PluginLlmService;
}

interface DisposableContext extends PluginContext {
  /** 框架内部：在调用 plugin.unregister() 前进入停止阶段并触发取消。 */
  beginStop(): void;
  /** 框架内部：卸载插件时统一清理已注册资源 */
  dispose(): Promise<void>;
}

/** 给基础 LLM 服务包装插件专属 purpose 前缀，便于用量归因和审计。 */
function wrapLlmPurpose(service: PluginLlmService, pluginId: string): PluginLlmService {
  return {
    generateText: (messages, options) => service.generateText(messages, {
      ...options,
      purpose: options?.purpose ? `${pluginId}:${options.purpose}` : pluginId,
    }),
    ...(service.runGoal ? { runGoal: service.runGoal } : {}),
  };
}

export function createContext(
  id: string,
  storageRoot: string,
  runtime: PluginRuntime,
  eventBus: Pick<PluginEventBus, "on" | "emit">,
  declaredDeps?: PluginManifest["deps"],
): DisposableContext {
  // dispose 阶段聚合的错误，在释放完成后统一告警。
  const cleanupErrors: unknown[] = [];
  // 全部临时资源（工具/IPC/渠道/事件订阅/Provider/onDispose）统一登记，
  // 停止时按注册逆序、单项超时与错误隔离地释放。
  const tracker = createPluginResourceTracker((kind, key, error) => {
    cleanupErrors.push(error);
  });
  const abortController = new AbortController();
  let stopping = false;
  let disposed = false;
  // 事件订阅与 onDispose 没有稳定业务 key，用自增序号保证唯一。
  let resourceSeq = 0;
  // 缓存同一次释放任务，避免异步清理让出事件循环时发生并发重入。
  let disposePromise: Promise<void> | undefined;

  // deps 白名单生效：只有 manifest.deps 声明且宿主提供的服务才会注入。
  // 声明了但宿主没有的能力属于硬依赖缺失，直接失败并走激活回滚，
  // 不让插件拿着不完整的 deps 误以为服务可用。
  const provided: PluginDeps = runtime.hostServices
    ? runtime.hostServices.createForPlugin({
      pluginId: id,
      signal: abortController.signal,
      trackResource: tracker,
    })
    : {
      channels: { has: (channelId) => runtime.channelManager.has(channelId) },
      ...(runtime.llm ? { llm: runtime.llm } : {}),
    };
  const deps: PluginDeps = {};
  for (const dep of declaredDeps ?? []) {
    const field = DEP_TO_FIELD[dep];
    const service = provided[field];
    if (!service) {
      throw new Error(`宿主未提供已声明的依赖: ${dep}`);
    }
    (deps as Record<string, unknown>)[field] = field === "llm"
      ? wrapLlmPurpose(service as PluginLlmService, id)
      : service;
  }

  /** 停止后统一拒绝登记新资源，避免框架登记与第三方状态出现半登记泄漏。 */
  function assertAcceptingResources(action: string): void {
    if (stopping || disposed) {
      throw new Error(`插件停止后不能再${action}`);
    }
  }

  const ctx: PluginContext = {
    id,
    signal: abortController.signal,
    onDispose(cleanup) {
      if (typeof cleanup !== "function") {
        throw new Error("插件清理回调必须是函数");
      }
      assertAcceptingResources("注册清理回调");
      tracker.track("onDispose", `dispose-${++resourceSeq}`, cleanup);
    },
    events: {
      on(event, listener) {
        assertAcceptingResources("订阅事件");
        // 订阅纳入资源跟踪器：插件停用时统一退订，不遗留跨生命周期监听器。
        const key = `subscription-${++resourceSeq}`;
        const unsubscribeFromBus = eventBus.on(
          event,
          listener as (payload: unknown) => void | Promise<void>,
        );
        tracker.track("event-subscription", key, () => {
          unsubscribeFromBus();
        });
        return () => {
          // 手动退订直接执行并移除登记，不走跟踪器的释放路径。
          try {
            unsubscribeFromBus();
          } finally {
            tracker.forget("event-subscription", key);
          }
        };
      },
      emit(event, payload) {
        // 插件只能发布自己的命名空间，不能伪造宿主或其他插件事件。
        return eventBus.emit(qualifyPluginEvent(id, event), payload);
      },
    },
    registerTool(tool) {
      const expectedPrefix = `${id}_`;
      if (!tool.id.startsWith(expectedPrefix)) {
        throw new Error(`插件工具 id 必须以 "${expectedPrefix}" 开头: ${tool.id}`);
      }
      assertAcceptingResources("注册工具");
      if (tracker.has("tool", tool.id)) {
        throw new Error(`插件工具 id 已由当前插件注册: ${tool.id}`);
      }
      const existing = runtime.toolRegistry.getById?.(tool.id);
      if (existing) {
        throw new Error(`插件工具 id 已被占用: ${tool.id}`);
      }
      runtime.toolRegistry.register(tool);
      tracker.track("tool", tool.id, () => {
        runtime.toolRegistry.unregister(tool.id);
      });
    },
    unregisterTool(toolId) {
      if (!tracker.has("tool", toolId)) {
        throw new Error(`不能注销不属于当前插件的工具: ${toolId}`);
      }
      runtime.toolRegistry.unregister(toolId);
      tracker.forget("tool", toolId);
    },
    registerPromptProvider(provider) {
      assertAcceptingResources("注册提示词 Provider");
      runtime.promptRegistry.register(id, provider, abortController.signal);
      tracker.track("prompt-provider", provider.id, () => {
        runtime.promptRegistry.unregister(id, provider.id);
      });
    },
    unregisterPromptProvider(providerId) {
      if (!tracker.has("prompt-provider", providerId)) {
        throw new Error(`不能注销不属于当前插件的提示词 Provider: ${providerId}`);
      }
      runtime.promptRegistry.unregister(id, providerId);
      tracker.forget("prompt-provider", providerId);
    },
    registerIpc(channel, handler) {
      if (!IPC_SEGMENT_RE.test(channel)) {
        throw new Error(`非法插件 IPC channel: ${channel}`);
      }
      assertAcceptingResources("注册 IPC channel");
      const full = `plugin:${id}:${channel}`;
      if (tracker.has("ipc", full)) {
        throw new Error(`插件 IPC channel 已注册: ${channel}`);
      }
      runtime.registerIpc(full, handler);
      tracker.track("ipc", full, () => {
        runtime.unregisterIpc(full);
      });
    },
    unregisterIpc(channel) {
      const full = `plugin:${id}:${channel}`;
      if (!tracker.has("ipc", full)) {
        throw new Error(`不能注销不属于当前插件的 IPC channel: ${channel}`);
      }
      runtime.unregisterIpc(full);
      tracker.forget("ipc", full);
    },
    async registerChannelAdapter(adapter) {
      assertAcceptingResources("注册渠道");
      if (tracker.has("channel-adapter", adapter.id)) {
        throw new Error(`插件渠道 id 已由当前插件注册: ${adapter.id}`);
      }
      if (runtime.channelManager.has(adapter.id)) {
        throw new Error(`插件渠道 id 已被占用: ${adapter.id}`);
      }
      runtime.channelManager.register(adapter);
      try {
        await runtime.channelManager.startOne(adapter.id);
      } catch (err) {
        // 半成功回滚：start 失败时撤销已注册的 adapter，避免 dispose 遗漏
        await runtime.channelManager.unregister(adapter.id);
        throw err;
      }
      tracker.track("channel-adapter", adapter.id, async () => {
        await runtime.channelManager.unregister(adapter.id);
      });
    },
    async unregisterChannelAdapter(channelId) {
      if (!tracker.has("channel-adapter", channelId)) {
        throw new Error(`不能注销不属于当前插件的渠道: ${channelId}`);
      }
      try {
        await runtime.channelManager.unregister(channelId);
      } finally {
        tracker.forget("channel-adapter", channelId);
      }
    },
    storage: createPluginStorage(storageRoot),
    deps,
    log(...args: unknown[]) {
      console.log(`[plugin:${id}]`, ...args);
    },
  };

  return Object.assign(ctx, {
    beginStop() {
      if (stopping || disposed) return;
      stopping = true;
      abortController.abort();
    },
    dispose() {
      if (!disposePromise) {
        disposePromise = (async () => {
          if (!stopping) {
            stopping = true;
            abortController.abort();
          }
          try {
            await tracker.dispose();
          } finally {
            disposed = true;
            if (cleanupErrors.length > 0) {
              console.warn(
                `[plugin:${id}] 清理资源时发生 ${cleanupErrors.length} 个错误`,
                cleanupErrors,
              );
            }
          }
        })();
      }
      return disposePromise;
    },
  });
}
