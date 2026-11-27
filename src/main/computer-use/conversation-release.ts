// 会话删除 → 删除该会话的自动截图并撤销桌面授权。
// 单独成文件，让 chats-ipc 不必为一次回调加载 Electron 快捷键、helper 进程等依赖。

let release: ((conversationId: string) => void) | undefined;

export function setComputerUseConversationRelease(handler: ((conversationId: string) => void) | undefined): void {
  release = handler;
}

export function releaseComputerUseConversation(conversationId: string): void {
  try {
    release?.(conversationId);
  } catch (error) {
    // 删除会话本身已经成功；截图残留由下次启动时的清理兜底。
    console.warn("[ComputerUse] 释放会话截图失败:", conversationId, error);
  }
}
