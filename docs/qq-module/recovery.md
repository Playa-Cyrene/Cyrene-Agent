# QQ 显式恢复与配置生命周期

恢复不是自动重放旧事务，也不依据磁盘的 selected 标记推断进程存在。协调器只接受主进程提供的来源、期望配置、安全凭据代次及受信候选校验；renderer 仅持有预览 ID 和需确认的账号。

## 来源与 canonical 配置

readQqRecoveryOrigin 只接受首次配置或旧驱动迁移中**恰好一个**完整 selected 来源。双来源、未完成阶段、旧含义不确定的 committed、损坏/缺失状态、陈旧锁及符号链接一律拒绝。原始状态、设置、聊天、绑定均不修改。

QqRecoveryStore 持久化：

- origin：原始来源类型、事务 ID、包 ID、非秘密配置；
- previous：本次动作之前的 canonical 配置、enabled、credentialRevision；
- desired：本次明确确认的期望配置；
- operation：recover 或 reconfigure；
- phase：prepared / module-staged / selected / disabled / rolled-back。

canonical 取 selected 或 disabled 的 desired；rolled-back 取 previous，**绝不把失败的新配置当作生效配置**。prepared、module-staged 及锁表示未完成操作，需要独立处理，不自动重试。既有恢复目录缺少状态文件也是不明状态，不回退为原始 enabled 配置。

历史首次配置/迁移记录尚无凭据代次。首次显式恢复绑定安全存储提供的当前非秘密 credentialRevision；后续恢复必须匹配已记录代次，变化须走 reconfigure。代次不是 token 内容、token 摘要或密码派生值。

## 恢复与修改配置

- recover：必须与 canonical 的配置、enabled 和已知凭据代次完全一致。disabled 不能通过恢复隐式启用。
- reconfigure：读取主机提出的完整期望快照，可修改允许名单、监听、账号、enabled 或凭据代次。非秘密运行配置改变时 configRevision 必须递增。
- 每个预览绑定来源、包、账号、期望配置和凭据代次；取消、替换、重复确认及异步期间变化均不能复用旧授权。
- 预览不停止进程、不创建恢复存储、不读取秘密。

确认后的顺序：

1. 重验来源和期望快照，保存 prepared 意图。
2. 可信主机撤销旧路由、停止并证明全部 QQ 驱动均已停止。该步骤发生在 durable intent **之后**。
3. 再次核对配置/凭据代次；启用时重新校验精确候选签名与选择，然后读取安全凭据。
4. 确认其他驱动仍不存在，创建且隔离启动新模块，确认真实 backend self ID。
5. 保存 module-staged，再核对其他驱动与所有可变输入。
6. 保存 selected，激活，再核对实际活跃代。

prepareAllDriversStopped(snapshot) 可执行停止；verifyNoOtherDrivers() 只能证明旧/其他驱动不存在，不能把已经启动的新隔离模块当作违规，也不能代替步骤2的全部停止证明。主机必须在整个操作期间保持单一 QQ 路由所有权。

## 禁用

desired.enabled=false 只保存意图、停止并证明全部驱动停止，再保存 disabled，不读凭据、不创建新进程。包过期、签名撤销或载荷损坏不能阻止停机，因此禁用不要求重新授权执行该包；重新启用仍必须通过候选验证。

## 失败与限制

失败尽量停止本次创建的候选，并保留 previous canonical。即使写入 rolled-back，若全部停止证明失败或其他驱动状态未知，对外仍返回 recovery-required，不能声称旧运行时已恢复。写盘或候选停止无法确认时保留未完成意图，不自动删锁。

本组件不提供任意清锁、损坏状态修复或重新启用旧驱动的捷径。它也不构成同 OS 用户攻击的隔离边界。正式信任策略、真实 Windows 安全存储/文件系统和真实 QQ/NapCat 验收仍由上层发布门槛约束。

测试使用真实持久化存储与实际 QqModuleManager、合成 IPC peer，覆盖两个原始来源、预览零副作用、确认顺序、账号隔离、禁用/重启、凭据代次、配置变更、完整写盘故障、canonical 回退、陈旧锁、损坏和断链路径。
