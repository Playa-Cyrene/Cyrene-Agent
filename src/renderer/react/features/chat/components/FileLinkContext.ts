// 文件链接环境 context：会话 ID + 工作区根 + 点击回调。
// 独立成文件：消息列表组件（ChatMessageList）与消费方（正文 anchor 渲染器、
// 文件变更卡片）互相引用会形成循环依赖，且会把消息列表的模块顶层副作用
// （头像资源解析等）拖进纯逻辑测试的 node 环境。
import { createContext } from "react";

export interface FileLinkEnv {
  /** 当前会话 ID：文件卡片右键"打开/定位"据此让主进程反查工作区绑定 */
  sessionId?: string;
  workspaceRoot?: string;
  openFile?: (relPath: string, line?: number) => void;
}

export const FileLinkContext = createContext<FileLinkEnv>({});
