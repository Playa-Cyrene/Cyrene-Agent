import type {
  PluginPromptBuildInput,
  PluginPromptProvider,
  PluginPromptSource,
} from "./types";

const PROMPT_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

export const PLUGIN_PROMPT_PROVIDER_TIMEOUT_MS = 2_000;
export const MAX_PLUGIN_PROMPT_CHARS = 16_000;
export const MAX_PLUGIN_PROMPT_TOTAL_CHARS = 32_000;

/** 未声明 sources 的 Provider 视为只参与既有场景，与旧版注册行为保持一致（向后兼容）。 */
const LEGACY_PROMPT_SOURCES: readonly PluginPromptSource[] = ["conversation", "scheduler"];

interface PromptEntry {
  ownerId: string;
  provider: PluginPromptProvider;
  signal: AbortSignal;
  isReady?: () => boolean;
}

export interface PluginPromptRegistry {
  register(ownerId: string, provider: PluginPromptProvider, signal: AbortSignal, isReady?: () => boolean): void;
  unregister(ownerId: string, providerId: string): boolean;
  build(input: PluginPromptBuildInput): Promise<string>;
  clear(): void;
}

function fullProviderId(ownerId: string, providerId: string): string {
  return `plugin:${ownerId}:${providerId}`;
}

/** 单个 Provider 失败或超时时返回空内容，避免第三方插件阻塞整轮对话。 */
async function resolveProvider(entry: PromptEntry, input: PluginPromptBuildInput): Promise<string> {
  const fullId = fullProviderId(entry.ownerId, entry.provider.id);
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  try {
    const content = await Promise.race([
      Promise.resolve(entry.provider.provide({ ...input, signal: entry.signal })),
      new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          reject(new Error(`提示词 Provider 超时（${PLUGIN_PROMPT_PROVIDER_TIMEOUT_MS}ms）`));
        }, PLUGIN_PROMPT_PROVIDER_TIMEOUT_MS);
      }),
    ]);
    if (typeof content !== "string") {
      throw new Error("提示词 Provider 必须返回字符串");
    }
    const normalized = content.trim();
    if (!normalized) return "";
    if (normalized.length > MAX_PLUGIN_PROMPT_CHARS) {
      console.warn(`[plugins] ${fullId} 提示词超过 ${MAX_PLUGIN_PROMPT_CHARS} 字符，已截断`);
      return normalized.slice(0, MAX_PLUGIN_PROMPT_CHARS);
    }
    return normalized;
  } catch (error) {
    console.warn(`[plugins] ${fullId} 提示词生成失败，已跳过`, error);
    return "";
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
  }
}

export function createPluginPromptRegistry(): PluginPromptRegistry {
  const entries = new Map<string, PromptEntry>();

  return {
    register(ownerId, provider, signal, isReady) {
      if (!provider || typeof provider !== "object") {
        throw new Error("插件提示词 Provider 必须是对象");
      }
      if (!PROMPT_ID_RE.test(provider.id)) {
        throw new Error(`非法插件提示词 Provider id: ${provider.id}`);
      }
      if (typeof provider.provide !== "function") {
        throw new Error("插件提示词 Provider 必须提供 provide() 函数");
      }
      if (provider.modes && (
        !Array.isArray(provider.modes)
        || provider.modes.some((mode) => !["chat", "work", "learn", "code"].includes(mode))
      )) {
        throw new Error("插件提示词 Provider modes 含未知模式");
      }
      // sources 是显式场景声明：必须为非空数组且只含合法场景字面量，
      // 否则拼写错误会静默失效，插件作者难以排查。
      // 用存在性判断而非真值判断：false/0 等假值同样非法，必须在注册时拒绝，
      // 而不是留到构建过滤的 includes() 处抛 TypeError 炸掉整个 registry。
      if (provider.sources !== undefined && (
        !Array.isArray(provider.sources)
        || provider.sources.length === 0
        || provider.sources.some((source) => !["conversation", "scheduler", "moments-post", "plugin-agent"].includes(source))
      )) {
        throw new Error(`插件提示词 Provider sources 非法: ${JSON.stringify(provider.sources)}`);
      }
      const fullId = fullProviderId(ownerId, provider.id);
      if (entries.has(fullId)) {
        throw new Error(`插件提示词 Provider 已注册: ${provider.id}`);
      }
      entries.set(fullId, { ownerId, provider, signal, isReady });
    },

    unregister(ownerId, providerId) {
      return entries.delete(fullProviderId(ownerId, providerId));
    },

    async build(input) {
      // 先拍快照再并行执行：结果仍按注册顺序拼接，运行中增删不会改变本轮内容。
      const snapshot = [...entries.values()].filter((entry) => {
        if (entry.signal.aborted || (entry.isReady && !entry.isReady())) return false;
        // 场景匹配：未声明 sources 的 Provider 只参与既有场景（向后兼容）。
        if (!(entry.provider.sources ?? LEGACY_PROMPT_SOURCES).includes(input.source)) return false;
        // moments-post 没有会话模式：是否生效仅由 sources 决定，绕过 modes 过滤（评审 ①）。
        if (input.source === "moments-post") return true;
        // 会话场景（conversation/scheduler）按 modes 匹配；判别联合保证此时 mode 必填。
        return !entry.provider.modes || entry.provider.modes.includes(input.mode);
      });
      const contents = await Promise.all(snapshot.map((entry) => resolveProvider(entry, input)));
      const blocks: string[] = [];
      let totalChars = 0;
      for (let index = 0; index < snapshot.length; index += 1) {
        const content = contents[index];
        if (!content) continue;
        const fullId = fullProviderId(snapshot[index].ownerId, snapshot[index].provider.id);
        const separator = blocks.length > 0 ? "\n\n---\n\n" : "";
        const header = `[插件上下文：${fullId}]\n`;
        const remaining = MAX_PLUGIN_PROMPT_TOTAL_CHARS - totalChars - separator.length - header.length;
        if (remaining <= 0) {
          console.warn(`[plugins] 插件提示词总长度超过 ${MAX_PLUGIN_PROMPT_TOTAL_CHARS} 字符，已忽略后续内容`);
          break;
        }
        const accepted = content.slice(0, remaining);
        blocks.push(separator + header + accepted);
        totalChars += separator.length + header.length + accepted.length;
        if (accepted.length < content.length) {
          console.warn(`[plugins] 插件提示词总长度超过 ${MAX_PLUGIN_PROMPT_TOTAL_CHARS} 字符，已截断`);
          break;
        }
      }
      return blocks.join("");
    },

    clear() {
      entries.clear();
    },
  };
}

export const pluginPromptRegistry = createPluginPromptRegistry();
