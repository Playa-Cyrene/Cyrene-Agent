# QQ 主机组合与未决发行政策

`createQqProductionHost` 将持久配置提案、安全凭据源、签名包/运行工厂、独立驱动所有权及安装/首次配置/恢复协调器组合起来。**应用启动仍没有调用或注入这个组合**，不会因这些代码存在就自动下载、安装、读旧 token 或激活 QQ。

## 已接通的入口

- 没有显式 `releasePolicy` 返回 undefined，零目录/凭据/进程工作。公钥、候选、版本/平台/时间校验策略仅来自审查后的主进程组合，不能来自 renderer、环境变量或包自身。
- 仅接受 blocked 的独占 QQ 路由。本轮生产组合是模块专用 scope，拒绝旧驱动迁移；通用迁移协调器仍保留，但不能把未纳管 legacy 的启动入口假称为已封闭。
- 设置编辑器只提交账号、回环监听、白名单、mention、启停等非秘密字段及 CAS 版本。主机分配配置版本和绑定现有安全凭据的随机代次；无 token/generation/path/key 输入。保存只是提案，不启动进程，不替换当前运行时。
- 启用提案必须匹配 active 凭据账号。禁用可以使用既有提案的代次，不因凭据损坏或不可用而无法停机。
- 操作预览固定 proposalId/revision，确认及异步边界重查。确认界面展示精确非秘密快照；另一窗口或主机源改变内容不能无声复用旧授权。
- 安全凭据仅在确认后的正确生命周期读取。真实适配器使用 Electron safeStorage，无 plaintext/混淆/basic_text 兜底。不存在自动导入旧 token 或 renderer 秘密 IPC。

## 受管进程证明

首次确认的 durable intent 写入后，才懒取得独占 owner epoch。每个 fork 之前持久化 dirty，再消耗一次性 grant；所有启动均走包装工厂。真实 utilityProcess `exit` 被登记，包括晚订阅的退出重放；kill 成功或 terminate Promise 结束不是退出证明。

恢复先停止当前实例，只有登记的全部受管实例实际退出后才能签发新 grant。激活前只能豁免本事务创建的那个实例。裸 manager.restart 不获新 grant，必须走显式恢复。禁用不保留可被工厂使用的 grant。

shutdown 先停止新请求、等待已确认操作、真实停止路由，随后写 clean-retired 并释放 lease。新主机仅能继承符合相同 scope 的 clean-retired 链；dirty/残锁/损坏/未知来源都保持阻断。任一生命周期或 ownership 目录存在都会阻止自动 fallback legacy。

这里的 driver 仅指该受管 Cyrene profile 的适配器/QFCA，不包括用户的 QQ 或 NapCat 客户端。代码不扫描或终止任意外部 QQ 进程，也不构成 OS sandbox。

## 必须由用户/维护者明确的决策

1. **发行信任**：发行组织和初始 keyId/公钥由谁确认？私钥由谁保管？轮换/撤销如何分发，离线时撤销与过期策略如何处理？不得以测试密钥代替正式决定。
2. **候选来源与支持矩阵**：正式签名候选从哪个经审查渠道获得？支持哪些 host/API 版本与 OS/架构？如何限制降级和发布序号？当前没有默认下载 URL。
3. **首次纳管依据**：何种经审查的安装/升级历史能够证明该 profile 不存在未纳管残留 driver？bootstrap 需要外部真实依据，不能把“新目录”“端口空闲”“没查到 PID”或用户按钮直接等同证明。本测试的 bootstrap 仅适用于独立创建且进程完全由测试拥有的 fixture。
4. **崩溃后的产品策略**：首版是否接受 dirty scope 必须人工核查？若要求自动恢复，需原生 containment/独立 broker 持有真实进程所有权并验证退出，不可用本 JS 层的 mock true 补齐。
5. **凭据录入/轮换流程**：用户通过哪个受信本地入口明确保存 token？目前提供主机 API，未开放秘密 renderer IPC，也不自动读取用户现有凭据。应用运行中撤销需先受控停机；改 NapCat 自身 token 是单独行为。
6. **正式验收平台**：真实 Windows DPAPI/ACL/安装器升级、真实 QQ/NapCat、完整屏幕交互及异常退出修复流程仍需独立验收。

在这些决策及验收完成前保持草稿，不启用生产、不合并、不发布。

## 隔离验证

单元/组合测试使用真实提案/凭据 envelope/所有权存储与管理器，仅进程边界为 synthetic peer；密码服务的 AES fixture 不等于 OS keychain。

`scripts/verify/qq-module/host-integration-electron.cjs` 使用完整签名离线 QFCA、实际 utilityProcess 和真实 owner exit 追踪，覆盖媒体、显式恢复、提案重配、禁用及 clean-retired 跨 host 继承。它会检查真实 Electron safeStorage：无可用安全后端时验证拒绝降级；组合链使用明确的临时 AES fixture，不能声称已验证 Windows DPAPI。运行命令见 host-integration.md。
