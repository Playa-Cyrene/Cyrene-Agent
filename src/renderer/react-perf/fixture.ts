// 阶段 0 性能基线 fixture：固定 seed 确定性生成会话数据与流式事件脚本。
// 三种数据集：plain（纯文本短会话）/ markdown（Markdown+代码块重型）/ mixed（推理块+工具执行混合）。
// 不读取、不写入任何真实用户数据；全部内容在内存中按 seed 重建，可无限次重放。

import type {
  ChatMessage,
  ChatSession,
  ChatSessionMeta,
  ReasoningBlock,
  RunActivityRecord,
  ToolExecutionRecord,
} from "../../shared/chat-types";
import type { AguiEvent } from "../react/features/chat/pages/chat-page-bridge";

export type PerfDataset = "plain" | "markdown" | "mixed";

/** AguiEvent 接口未声明 RUN_FINISHED 的终态字段；AgentRunController 运行时以 event.result.status 读取 */
type TerminalAguiEvent = AguiEvent & { result?: { status?: string } };

/** 构造 RUN_FINISHED 终态事件（成功 / 取消等），与真实主进程协议一致 */
export function runFinishedEvent(runId: string, status: string): AguiEvent {
  const event: TerminalAguiEvent = { type: "RUN_FINISHED", runId, result: { status } };
  return event;
}

export interface PerfFixtureOptions {
  dataset: PerfDataset;
  /** 会话内历史消息总条数（用户+助手交替） */
  count: number;
  seed: number;
}

/** mulberry32：32 位确定性 PRNG，同一 seed 生成完全一致的序列 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rand: () => number, items: readonly T[]): T {
  return items[Math.floor(rand() * items.length)]!;
}

// ── 文本素材库（中文为主，贴近真实使用；内容由 seed 确定性挑选） ──

const USER_TEXTS = [
  "帮我把这段代码里的循环改写成更高效的写法",
  "今天下午三点提醒我参加项目评审会议",
  "最近总感觉注意力不集中，有什么改善的方法吗",
  "帮我看一下这个报错是什么意思：TypeError: cannot read property of undefined",
  "给我推荐几本关于系统设计的书，最好有中文版",
  "这个函数的时间复杂度能优化到线性吗？现在循环套循环太慢了",
  "帮我总结一下今天会议里提到的三个待办事项",
  "为什么我的打包体积突然变大了？上个月还是两兆",
  "写一首关于秋天傍晚的小诗，四句就行",
  "解释一下 React 里 useMemo 的依赖数组机制",
];

const PLAIN_ANSWERS = [
  "好的，这个问题可以从两个层面来看。首先是整体结构：把重复计算的部分提取出来，避免在循环内部反复执行相同的操作。其次是数据结构的选择：如果查找是热点路径，用哈希表替换数组遍历通常能把复杂度从线性降到常数。\n\n不过也要注意权衡，数据量小的时候哈希表的开销可能反而更高，建议先用真实数据量做一次对比测试再决定。",
  "可以从这几个方面入手：一是保证规律的作息，睡眠不足会直接影响工作记忆；二是把大任务拆成小块，每块控制在二十五分钟左右，中间安排短暂休息；三是减少上下文切换，同一时间只处理一件事，切换的成本比想象中高很多。\n\n如果长期如此且影响生活，也可以考虑咨询专业人士的意见。",
  "这个报错说明你在访问一个对象的属性之前，对象本身是 undefined。常见原因有三种：异步数据还没返回就开始取值、函数参数漏传、或者数据结构和你以为的不一样。\n\n建议先在取值前打印一下变量本身，确认它到底在哪一步变成了 undefined，再决定是加空值保护还是修正调用顺序。",
  "时间复杂度优化到线性是可行的，关键在于消除内层循环的重复扫描。当前写法里每次都要从头找一遍，但其实可以维护一个哈希映射，把已经见过的元素记下来，整体只扫一遍就能出结果。\n\n代价是多了一份辅助空间，空间复杂度从常数变成线性，属于典型的空间换时间。",
];

const CODE_TS = [
  "```ts",
  "interface CacheEntry<T> {",
  "  value: T;",
  "  expiresAt: number;",
  "}",
  "",
  "export function createMemoCache<T>(ttlMs: number) {",
  "  const store = new Map<string, CacheEntry<T>>();",
  "  return {",
  "    get(key: string): T | undefined {",
  "      const entry = store.get(key);",
  "      if (!entry) return undefined;",
  "      if (entry.expiresAt < Date.now()) {",
  "        store.delete(key);",
  "        return undefined;",
  "      }",
  "      return entry.value;",
  "    },",
  "    set(key: string, value: T) {",
  "      store.set(key, { value, expiresAt: Date.now() + ttlMs });",
  "    },",
  "  };",
  "}",
  "```",
].join("\n");

const CODE_PY = [
  "```python",
  "def merge_intervals(intervals: list[list[int]]) -> list[list[int]]:",
  "    if not intervals:",
  "        return []",
  "    intervals.sort(key=lambda item: item[0])",
  "    merged = [intervals[0]]",
  "    for start, end in intervals[1:]:",
  "        last = merged[-1]",
  "        if start <= last[1]:",
  "            last[1] = max(last[1], end)",
  "        else:",
  "            merged.append([start, end])",
  "    return merged",
  "```",
].join("\n");

const MARKDOWN_ANSWERS = [
  `## 问题分析\n\n当前实现的瓶颈在于**每次渲染都全量重建列表**，可以从三个方向入手：\n\n1. 减少不必要的重渲染（引用稳定化）\n2. 把全量计算拆成单条缓存\n3. 必要时再考虑虚拟化\n\n### 示例代码\n\n${CODE_TS}\n\n> 注意：缓存失效规则要保持单一，不要同时维护版本号和整体替换两套机制。\n\n### 复杂度对比\n\n| 方案 | 时间复杂度 | 空间复杂度 | 备注 |\n| --- | --- | --- | --- |\n| 全量重建 | O(n) | O(1) | 基线 |\n| 单条缓存 | O(1) 均摊 | O(n) | 空间换时间 |\n\n相关阅读可以参考 [React 官方文档](https://react.dev) 里关于 \`useMemo\` 的章节。`,
  `## 实现思路\n\n分治策略的核心是**把大问题拆成同构的小问题**，拆到可以直接求解的粒度再逐层合并。\n\n### Python 版本\n\n${CODE_PY}\n\n### 边界情况\n\n- 空输入直接返回\n- 只有一个区间时无需合并\n- 区间已经是排好序的（可省略排序步骤）\n\n数学上可以证明合并后的区间两两不相交：假设 $A=[a_1, b_1]$ 与 $B=[a_2, b_2]$ 且 $a_2 \\le b_1$，则合并结果 $[a_1, \\max(b_1, b_2)]$ 覆盖了两者的并集。`,
  `## 排查步骤\n\n遇到构建体积异常时按下面的顺序排查，通常能快速定位：\n\n1. 先对比两次构建的产物清单，找出增量最大的 chunk\n2. 确认是否新引入了大体积依赖（图标库、图表库最常见）\n3. 检查 tree-shaking 是否生效：\`import { Button } from "lib"\` 优于 \`import lib from "lib"\`\n\n\`\`\`ts\n// 按需引入：只打包用到的部分\nimport { debounce } from "lodash-es";\n\n// 全量引入：整个库都会进 bundle\nimport _ from "lodash";\n\`\`\`\n\n### 常见误判\n\n> 体积变大不一定是代码变多，source map 文件、重复打包的多版本依赖也会撑大产物目录。`,
];

const REASONING_TEXTS = [
  "用户问的是性能优化方向，先分析现有结构找出热点，再决定是缓存还是虚拟化。历史消息每次全量重建确实可疑，但要用数据说话。",
  "这个报错信息指向空值访问，需要先确认数据流：异步返回前取值、参数漏传、结构不匹配，三种情况的处理方式各不相同。",
  "先理清需求边界：数据量多大、更新频率多高、是否需要动画。如果列表几百条以内，先做引用稳定化可能比虚拟化收益更大。",
];

const TOOL_NAME_BANK = ["web_search", "read_file", "write_file", "run_command", "fetch_url"];

function toolResultText(name: string): string {
  if (name === "web_search") return JSON.stringify({ results: [{ title: "示例结果", snippet: "相关内容摘录", url: "https://example.com" }] });
  if (name === "read_file" || name === "write_file") return JSON.stringify({ ok: true, path: "src/example.ts", lines: 42 });
  return JSON.stringify({ ok: true, exitCode: 0, durationMs: 320 });
}

function plainAnswer(rand: () => number): string {
  return pick(rand, PLAIN_ANSWERS);
}

function markdownAnswer(rand: () => number): string {
  return pick(rand, MARKDOWN_ANSWERS);
}

/** 生成一条历史用户消息 */
function buildUserMessage(id: string, at: number, rand: () => number): ChatMessage {
  return {
    id,
    role: "user",
    content: pick(rand, USER_TEXTS),
    at,
  };
}

/** 生成一条历史助手消息（按数据集填充不同结构） */
function buildAssistantMessage(
  id: string,
  at: number,
  rand: () => number,
  dataset: PerfDataset,
  index: number,
): ChatMessage {
  if (dataset === "plain") {
    return { id, role: "model", content: plainAnswer(rand), at };
  }
  if (dataset === "markdown") {
    return { id, role: "model", content: markdownAnswer(rand), at };
  }
  // mixed：推理块 + 工具执行 + 正文交替出现；一半带 runActivity（走活动卡渲染路径）
  const toolCount = 1 + Math.floor(rand() * 3);
  const tools: ToolExecutionRecord[] = [];
  for (let i = 0; i < toolCount; i += 1) {
    const name = TOOL_NAME_BANK[(index + i) % TOOL_NAME_BANK.length]!;
    tools.push({
      id: `${id}-tool-${i}`,
      name,
      displayName: name === "web_search" ? "网页搜索" : name === "read_file" ? "读取文件" : name === "write_file" ? "写入文件" : name === "run_command" ? "执行命令" : "抓取网页",
      status: "success",
      result: toolResultText(name),
      argsText: JSON.stringify({ query: "性能优化" }),
      seq: i,
    });
  }
  const reasoning: ReasoningBlock[] = [
    { id: `${id}-reasoning`, content: pick(rand, REASONING_TEXTS), seq: toolCount },
  ];
  const message: ChatMessage = {
    id,
    role: "model",
    content: plainAnswer(rand),
    reasoningBlocks: reasoning,
    toolExecutions: tools,
    at,
  };
  if (index % 2 === 0) {
    const activity: RunActivityRecord = {
      startedAt: at,
      completedAt: at + 4200,
      reasoningMs: 1800,
    };
    message.runActivity = activity;
  }
  return message;
}

/** 构建性能基线会话：固定 seed 确定性生成，不触碰真实用户数据 */
export function buildPerfSession(options: PerfFixtureOptions): ChatSession {
  const { dataset, count, seed } = options;
  const rand = mulberry32(seed);
  const now = Date.now();
  const messages: ChatMessage[] = [];
  for (let i = 0; i < count; i += 1) {
    const at = now - (count - i) * 60_000;
    messages.push(
      i % 2 === 0
        ? buildUserMessage(`perf-m-${i}`, at, rand)
        : buildAssistantMessage(`perf-m-${i}`, at, rand, dataset, i),
    );
  }
  return {
    id: "perf-session",
    title: "性能基线会话",
    identityId: null,
    messages,
    createdAt: now - (count + 10) * 60_000,
    updatedAt: now - 60_000,
    schemaVersion: 1,
    mode: "chat",
  };
}

/** 会话列表元数据（内存 store 的 list 返回值） */
export function perfSessionMeta(session: ChatSession): ChatSessionMeta {
  return {
    id: session.id,
    title: session.title,
    identityId: session.identityId,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    messageCount: session.messages.length,
    mode: "chat",
  };
}

// ── 流式事件脚本 ──

export interface ScriptedEvent {
  atMs: number;
  event: AguiEvent;
}

export interface StreamingScript {
  events: ScriptedEvent[];
  /** 正文 delta 事件数（事件到绘制延迟的样本基数） */
  deltaCount: number;
  /** 流式正文总字符数 */
  streamLength: number;
}

/** 按码点把目标文本切成 min~max 字符的 delta 序列（不拆代理对） */
function sliceDeltas(text: string, rand: () => number, min: number, max: number): string[] {
  const chars = Array.from(text);
  const deltas: string[] = [];
  let i = 0;
  while (i < chars.length) {
    const size = min + Math.floor(rand() * (max - min + 1));
    deltas.push(chars.slice(i, i + size).join(""));
    i += size;
  }
  return deltas;
}

/** 生成流式目标正文：循环拼接素材库直到达到目标长度 */
function buildStreamTarget(dataset: PerfDataset, rand: () => number, minLength: number): string {
  const parts: string[] = [];
  let length = 0;
  let round = 0;
  while (length < minLength) {
    parts.push(dataset === "plain" ? plainAnswer(rand) : markdownAnswer(rand));
    length = parts.join("\n\n").length;
    round += 1;
    if (round > 50) break;
  }
  return parts.join("\n\n");
}

export interface StreamingScriptOptions {
  dataset: PerfDataset;
  seed: number;
  /** 流式持续时间（ms） */
  durationMs: number;
}

/**
 * 构建完整流式事件脚本（RUN_STARTED → 推理/工具前置 → 正文 delta → 终态）。
 * 与真实 AgentRunController 的事件消费路径一致：所有事件携带 runId 供 RunEventGate 放行。
 */
export function buildStreamingScript(options: StreamingScriptOptions): StreamingScript {
  const { dataset, seed, durationMs } = options;
  const rand = mulberry32(seed + 9999);
  const events: ScriptedEvent[] = [];
  const runId = "perf-run-1";

  events.push({ atMs: 0, event: { type: "RUN_STARTED", runId } });

  let cursor = 240;

  // mixed 数据集：先流一段推理，再执行若干工具，最后进入正文
  if (dataset === "mixed") {
    const reasoningText = `${pick(rand, REASONING_TEXTS)}${pick(rand, REASONING_TEXTS)}`;
    const reasoningDeltas = sliceDeltas(reasoningText, rand, 16, 48);
    events.push({ atMs: cursor, event: { type: "REASONING_MESSAGE_START", runId, messageId: "perf-reasoning-1" } });
    cursor += 60;
    for (const delta of reasoningDeltas) {
      events.push({ atMs: cursor, event: { type: "REASONING_MESSAGE_CONTENT", runId, messageId: "perf-reasoning-1", delta } });
      cursor += 55;
    }
    events.push({ atMs: cursor, event: { type: "REASONING_MESSAGE_END", runId, messageId: "perf-reasoning-1" } });
    cursor += 120;

    const toolCount = 3;
    for (let i = 0; i < toolCount; i += 1) {
      const name = TOOL_NAME_BANK[i % TOOL_NAME_BANK.length]!;
      const toolCallId = `perf-tool-${i}`;
      events.push({ atMs: cursor, event: { type: "TOOL_CALL_START", runId, toolCallId, toolCallName: name, toolCallDisplayName: name === "web_search" ? "网页搜索" : "读取文件" } });
      cursor += 90;
      for (const chunk of sliceDeltas('{"query":"性能优化 baseline"}', rand, 6, 16)) {
        events.push({ atMs: cursor, event: { type: "TOOL_CALL_ARGS", runId, toolCallId, delta: chunk } });
        cursor += 40;
      }
      cursor += 260;
      events.push({ atMs: cursor, event: { type: "TOOL_CALL_RESULT", runId, toolCallId, status: "success", content: toolResultText(name) } });
      cursor += 60;
      events.push({ atMs: cursor, event: { type: "TOOL_CALL_END", runId, toolCallId } });
      cursor += 140;
    }
  }

  // 正文流式：32ms 节拍、每次 8~32 字符，直到 durationMs
  const textStart = cursor + 120;
  const usable = Math.max(2000, durationMs - textStart - 400);
  const avgCharsPerTick = 20;
  const targetLength = Math.ceil((usable / 32) * avgCharsPerTick);
  const targetText = buildStreamTarget(dataset, rand, targetLength);
  const deltas = sliceDeltas(targetText, rand, 8, 32);

  events.push({ atMs: textStart, event: { type: "TEXT_MESSAGE_START", runId, messageId: "perf-stream-msg" } });
  let at = textStart + 40;
  let deltaCount = 0;
  for (const delta of deltas) {
    if (at > textStart + usable) break;
    events.push({ atMs: at, event: { type: "TEXT_MESSAGE_CONTENT", runId, messageId: "perf-stream-msg", delta } });
    at += 32;
    deltaCount += 1;
  }
  const streamEnd = at + 120;
  events.push({ atMs: streamEnd, event: { type: "TEXT_MESSAGE_END", runId, messageId: "perf-stream-msg" } });
  events.push({ atMs: streamEnd + 160, event: runFinishedEvent(runId, "success") });

  return { events, deltaCount, streamLength: targetText.length };
}
