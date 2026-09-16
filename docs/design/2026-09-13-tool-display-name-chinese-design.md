# 工具执行显示中文化：displayName 直通链路

## 目标

工具执行时，前端各处（顶部状态条、工具执行卡片、定时任务消息）不再直接显示英文工具 ID（如 `music_play_track`、`ast_grep_search`），改为主进程注册表里已有的中文展示名（如「播放歌曲」、「AST 代码搜索」）。

一次改动覆盖全部内置工具 + MCP 动态注册工具，后续新增工具自动生效，前端零维护。

---

## 背景与现状

主进程注册表（`ToolDefinition.name`）里每个工具都已有中文展示名：

- 内置工具：[fs-tools.ts](../../src/main/orchestrator/tools/fs-tools.ts)、[document-tools.ts](../../src/main/orchestrator/tools/document-tools.ts) 等，如 `read_file` → 「读取文件」
- MCP 工具：[mcp-adapter.ts](../../src/main/orchestrator/mcp-adapter.ts#L167) 注册时生成 `[服务名] 工具名`

但这个中文名没有随执行事件传给前端，导致三处显示英文原名：

| 显示位置 | 前端代码 | 问题 |
|---|---|---|
| 顶部状态条「昔涟正在执行：xxx…」 | [AgentRunController.ts](../../src/renderer/react/features/chat/pages/run/AgentRunController.ts#L637) | 直接用英文 ID 做 detail |
| 工具执行卡片标题/状态文案 | [agent-rounds.ts](../../src/renderer/react/features/chat/components/agent-rounds.ts#L17-L27) | 仅硬编码翻译了 9 个常用工具，其余 40+ 及全部 MCP 工具显示英文 |
| 定时任务消息工具列表 | [useSchedulerEvents.ts](../../src/renderer/react/features/chat/hooks/useSchedulerEvents.ts#L147) | 直接存英文 ID |

事件链路断点：

```
主进程 tool-dispatcher ── tool_start { toolName: 英文ID }        ← 中文名没上车
  → event-mapper ── TOOL_CALL_START { toolCallName: 英文ID }     ← 透传
    → 前端 AgentRunController ── ToolExecutionRecord { name }   ← 只有英文可用
```

---

## 设计

### 数据流（改后）

```
主进程 tool-dispatcher
  └─ tool_start { toolCallId, toolName: "music_play_track", displayName: "播放歌曲" }
       └─ event-mapper → AG-UI TOOL_CALL_START { toolCallId, toolCallName, toolCallDisplayName }
            └─ AgentRunController → ToolExecutionRecord { name: "music_play_track", displayName: "播放歌曲" }
                 └─ agent-rounds.ts 取标签：displayName → i18n 映射 → 原始 ID
```

### 显示回退链（三层）

```
记录里的 displayName（新链路带来的中文名）
  → 现有 i18n 映射表（agentRounds.* 那 9 个 key）
    → 原始英文 ID（最后兜底）
```

三层保证：历史会话里已存的旧记录（无 displayName）走第二/三层，显示不坏；新记录直接显示中文。

### 关键约束

- `ToolExecutionRecord.name` **保持原始工具 ID 不动**：`run_shell` 超时判断、完成摘要统计（`SUMMARY_TOOL_KEYS`）、状态条 detail 都按 ID 匹配，改它会把摘要功能改坏。中文名只进新增的 `displayName` 字段。
- 所有新字段一律可选（`?`），不迁移旧数据、不改已有事件结构。
- harness 内置工具（`ask_user`、`update_todo` 等）走专属事件类型（`todo_update` / `ask_user`），不经过 `tool_start` 链路，不受本次改动影响。
- 权限审批卡片已用注册表中文名（`toolName: tool.name`），无需改。

---

## 分阶段执行

### 阶段一：主进程 —— 中文名随事件下发

独立合入即向后兼容（新字段无消费者，行为零变化）。

| 文件 | 改动 |
|---|---|
| [harness/types.ts](../../src/main/orchestrator/harness/types.ts#L164) | `tool_start` 事件类型加 `displayName?: string` |
| [tool-dispatcher.ts](../../src/main/orchestrator/harness/tool-dispatcher.ts#L160-L165) | 发 `tool_start` 时补 `displayName: tool.name`（工具在上方已解析，MCP 工具同样在 `ctx.tools` 里，自动覆盖） |
| [event-mapper.ts](../../src/main/orchestrator/harness/adapter/event-mapper.ts#L62-L69) | `TOOL_CALL_START` 透传 `toolCallDisplayName`（加自定义字段，与已有的 `changes` 字段同一先例） |
| [cyrene-agent.ts](../../src/main/orchestrator/cyrene-agent.ts#L260-L265) | 旧路径 `toAguiEvent` 里查一次 `toolRegistry` 补 `displayName`，查不到不填 |

**验证**：`npx vitest run src/main/orchestrator/harness` 通过；类型检查通过；跑一次对话确认事件流无异常。

### 阶段二：共享类型与前端主链路 —— 存储与展示

| 文件 | 改动 |
|---|---|
| [chat-types.ts](../../src/shared/chat-types.ts#L36-L45) | `ToolExecutionRecord` 加 `displayName?: string` |
| [chat-page-bridge.ts](../../src/renderer/react/features/chat/pages/chat-page-bridge.ts#L64) | 事件类型声明加 `toolCallDisplayName?: string` |
| [AgentRunController.ts](../../src/renderer/react/features/chat/pages/run/AgentRunController.ts#L630-L638) | `TOOL_CALL_START` 分支把 `displayName` 存进执行记录（`updateRunTool` 新建分支需同步带上该字段）；状态条 `detail` 改用中文名，无中文名再回退原值 |
| [agent-rounds.ts](../../src/renderer/react/features/chat/components/agent-rounds.ts#L40-L55) | `liveToolLabel` / `toolDisplayLabel` / `toolActionLabel` 三个函数优先取记录里的 `displayName`，再走现有 i18n 映射 |

**验证**：跑一次带工具的任务（如让昔涟写文件），三处检查：
1. 顶部状态条显示「昔涟正在执行：写入文件…」
2. 工具卡片标题为中文，状态文案「正在写入文件」
3. 切走再切回会话，历史恢复后仍显示中文

### 阶段三：定时任务链路

| 文件 | 改动 |
|---|---|
| [useSchedulerEvents.ts](../../src/renderer/react/features/chat/hooks/useSchedulerEvents.ts#L147) | `TOOL_CALL_START` 分支存 `displayName`；`RUN_FINISHED` 兜底摘要行（L199）优先用 `displayName` |

**验证**：`npx vitest run src/renderer/react/features/chat/hooks/useSchedulerEvents.test.ts` 通过；手动触发一次定时任务看消息里的工具行。

### 阶段四：测试补全与整体验证

**新增测试用例**（[agent-rounds.test.ts](../../src/renderer/react/features/chat/components/agent-rounds.test.ts)）：

1. 有 `displayName` 的记录 → 标签与状态文案用中文名
2. 无 `displayName` 但 ID 在映射表内 → 走现有 i18n 映射（历史数据回退）
3. 两者皆无的未知名 → 原样显示 ID

**整体回归**：

- `npx vitest run`（全量）
- 手动跑一次 MCP 工具任务（如网易云点歌），确认显示「[cloud-music] search_song」这类带前缀名或未来配置的中文服务名
- 历史会话抽查：打开改造前含工具执行记录的会话，显示不报错、回退正常

---

## 风险与回退

- **风险低**：全部为可选字段追加，主进程阶段独立合入时前端零感知；前端阶段对旧数据显示回退链兜底。
- **回退**：任一阶段出问题，直接 revert 该阶段提交即可；阶段间无数据迁移、无破坏性依赖。
