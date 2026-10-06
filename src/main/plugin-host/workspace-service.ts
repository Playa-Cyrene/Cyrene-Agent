import type { PluginWorkspaceBinding, PluginWorkspaceService } from "../../plugins/api";
import { pluginHostError } from "./errors";

/** 工作区绑定在宿主存储中的最小只读形状。 */
export interface PluginWorkspaceStoreReader {
  getWorkspaceBinding(sessionId: string): ({ workspaceRoot: string; displayName: string } | undefined) | Promise<{ workspaceRoot: string; displayName: string } | undefined>;
}

export interface PluginWorkspaceServiceOptions {
  reader: PluginWorkspaceStoreReader;
  /** 插件停止信号；停止后所有调用返回 E_PLUGIN_STOPPING。 */
  signal?: AbortSignal;
}

/**
 * 只读的工作区投影服务：会话不存在和未绑定工作区都返回 null，
 * 不提供绑定、解绑或目录选择等写接口。
 */
export function createPluginWorkspaceService(options: PluginWorkspaceServiceOptions): PluginWorkspaceService {
  const { reader, signal } = options;

  return {
    async getBinding(conversationId) {
      if (signal?.aborted) {
        throw pluginHostError("E_PLUGIN_STOPPING", "插件已停止，工作区服务不可用");
      }
      if (typeof conversationId !== "string" || !conversationId) {
        throw pluginHostError("E_INVALID_ARGUMENT", `非法会话 id: ${String(conversationId)}`);
      }
      const binding = (await reader.getWorkspaceBinding(conversationId));
      if (!binding) return null;
      // 只投影稳定字段，绑定时间等内部细节不透出。
      const projection: PluginWorkspaceBinding = {
        conversationId,
        root: binding.workspaceRoot,
        displayName: binding.displayName,
      };
      return projection;
    },
  };
}
