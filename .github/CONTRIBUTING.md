# 贡献指南

感谢你为 Cyrene 贡献代码！

提交 PR 前请先阅读本文档。最重要的一条规则：

> **部分核心模块的改动，请先通过 Issue 讨论方向，不要直接提 PR。**
> 如果实现方向与维护者的规划不一致，未经讨论的 PR 可能会被直接关闭——这不是对贡献本身的否定，而是避免你的工作量被浪费。

通用的 PR 要求（标题格式、语言、最小改动、测试说明等）见 PR 模板，提交时会自动填充。

## 模型适配贡献

模型更新快，等不及适配时，可以直接提交 PR（合并请求）：有依据的型号目录补充、单厂商能力声明和对应回归用例不需要先等待维护者开 Issue（问题单）。入口见 [模型适配贡献指南](../docs/contributing/model-adaptation.md) 和 [模型适配清单](../docs/references/adapted-models.md)。

新厂商、新协议、认证或公共请求策略、端点判定和接口契约变化，先用模型问题单讨论。下面的核心模块讨论规则仍适用于这些公共行为变化。

---

## 哪些改动需要先开 Issue 讨论

### 判定原则

先问自己三个问题，任何一个答「是」，请先开 Issue：

1. 这个改动会改变**其他模块依赖的行为**吗（而不是只改内部实现）？
2. 这个改动会引入**新的状态、生命周期或持久化格式**吗？
3. 合并后**很难回退**吗（涉及数据迁移、外部契约、安全边界）？

如果都不满足，通常可以直接提 PR。

---

### Harness（智能体运行框架）

代码位置：`src/main/orchestrator/harness/`、`src/main/orchestrator/` 下的 `agent-runtime.ts`、`chat-loop.ts`、`cyrene-agent.ts`、`harness-adapter.ts`

先讨论：

- run 生命周期的改动：终态种类、统一结算语义、取消/超时/错误的区分方式
- 对话主循环的轮次结构、重试策略、中断传播（AbortSignal 如何贯穿）
- Harness 抽象层接口变更（新增或修改 adapter 方法签名）
- AG-UI bridge 的事件顺序

可直接 PR：不改变语义的 Bug 修复（如某终态漏调清理）、纯内部重构、日志补充

---

### Memory（记忆）

代码位置：`src/main/memory/`

先讨论：

- 记忆的判定与冲突策略：什么算重要、新旧记忆怎么合并、怎么淘汰（memory-judge / memory-conflict / memory-compressor）
- 存储结构变更：schema 调整、新增迁移（memory-store-migrations）
- 注入逻辑：哪些记忆进上下文、按什么排序（memory-resolver / recent-injected-memory）
- DMAE 相关的行为调整

可直接 PR：导入导出（Obsidian）的 Bug 修复、记忆管理 UI 改进

---

### Plugin API（插件接口）

代码位置：`src/plugins/`、`packages/plugin-sdk/`

先讨论：

- `manifest.schema.json` 任何字段变更（新增可选字段也建议先说）
- 事件总线命名空间模型（`host:*` / `plugin:<id>:` 前缀规则）
- 动态提示词 Provider 机制：配额、超时、生效模式
- 插件生命周期状态机的状态与转移
- 安全边界：ZIP 导入防护规则、资源所有权、插件能拿到什么

可直接 PR：示例插件、SDK 文档、不改变契约的内部 Bug 修复

---

### Tool system（工具系统）

代码位置：`src/main/orchestrator/tools/`

先讨论：

- 新增内置工具（尤其涉及写入文件、执行命令、网络访问的）
- 工具在各模式（chat / work / learn / code）的暴露规则
- 工具参数或返回格式的契约变更（参数名、返回 JSON 结构）
- 写入防护机制的调整：覆写检查阈值、快照、熔断规则
- 工具的移除或重命名

可直接 PR：工具 description 文案改进、不改变行为的 Bug 修复

---

### Context（上下文）

代码位置：`src/main/orchestrator/` 下的 `build-options.ts`、`context-manager.ts`、`prompt-layers.ts`，`src/main/runtime-policy/token-budget.ts`，Worldbook 注入

先讨论：

- 提示词分层结构的调整：什么进固定人设层、什么进运行时层（直接影响提示词缓存命中）
- 压缩/裁剪策略：阈值、裁什么保什么、恢复逻辑
- Token 预算的分配方式
- 各来源（记忆 / Worldbook / 工具结果 / 对话历史）的注入顺序与格式

可直接 PR：纯展示层的改动（Context viewer 界面）、注入格式的 Bug 修复

---

### Permission（权限）

代码位置：`src/main/permission.ts`、`src/main/permission/`、`user-choice.ts`、`shell-execution-policy.ts`、sandbox

先讨论：

- 任何**放宽**权限的改动（默认放行、白名单扩大、跳过审批）
- 审批流语义：结算路径、pending 重播间隔、终态清理
- 沙箱策略与 shell 执行策略的规则变更
- 新增需要审批的工具操作类型

可直接 PR：审批卡片的 UI/文案、不改变安全语义的 Bug 修复

---

### Scheduler（调度器）

代码位置：`src/main/scheduler/`、`src/main/orchestrator/task-runtime.ts`

先讨论：

- 调度引擎语义：错过任务怎么处理、nextFireAt 重排规则
- 插件任务的宿主不变量：`enabled` / `toolMode` 不可 patch、授权指纹、所有权检查
- 任务存储 schema 变更
- 任务与权限/工具白名单的关系调整

可直接 PR：保持语义不变的 Bug 修复（如时区计算错误）、调度 UI 改进

---

## 如何发起讨论

开一个 Issue，说明：

1. 想解决什么问题
2. 打算怎么改（大致方向即可，不需要完整设计）
3. 为什么现有实现不能满足

维护者确认方向后，再动手实现并提 PR，并在 PR 中关联该 Issue（`Closes #编号`）。
