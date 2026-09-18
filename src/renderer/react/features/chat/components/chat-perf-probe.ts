// 聊天渲染性能探针：默认完全空操作。
// 只有 perf harness 页面（src/renderer/react-perf）在 React 挂载前向 window
// 注册 __cyreneChatPerfProbe 计数器后才会真正计数，业务运行零成本。
// 用途：聊天渲染性能基线与阶段验收（docs/internal-issue/2026-09-17-chat-renderer-performance-known-issues.md）；
// 基线与优化后共用同一探针，保证前后数据可比。

export interface ChatPerfProbeCounters {
  /** 消息正文（Markdown）渲染执行次数：Bubble contentRender → MarkdownContent */
  markdownRenders: number;
  /** ChatPageNavigation 组件执行次数 */
  navigationRenders: number;
  /** ConversationSidebar 组件执行次数 */
  sidebarRenders: number;
  /** ChatMessageList 组件执行次数：列表外壳渲染（含 Bubble.List/全部 footer），补 markdownRenders 覆盖不到的路径 */
  listRenders: number;
}

/** 上报一次渲染执行；未注册计数器时为空操作（一次属性读取 + 判断） */
export function reportChatPerfRender(key: keyof ChatPerfProbeCounters): void {
  // node 环境测试（renderToStaticMarkup）没有 window：直接跳过
  if (typeof window === "undefined") return;
  const counters = (window as typeof window & { __cyreneChatPerfProbe?: ChatPerfProbeCounters })
    .__cyreneChatPerfProbe;
  if (counters && typeof counters[key] === "number") {
    counters[key] += 1;
  }
}
