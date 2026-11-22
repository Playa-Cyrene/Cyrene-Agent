# QQ 主机组合与未决发行政策

`createQqProductionHost` 将持久配置提案、安全凭据源、签名包/运行工厂、独立驱动所有权及安装/首次配置/恢复协调器组合起来。**应用启动仍没有调用或注入这个组合**，不会因这些代码存在就自动下载、安装、读旧 token 或激活 QQ。

## 已接通的入口

- 没有显式 `releasePolicy` 返回 undefined，零目录/凭据/进程工作。公钥、候选、版本/平台/时间校验策略仅来自审查后的主进程组合，不能来自 renderer、环境变量或包自身。
- 默认仅接受 blocked 的独占 QQ 路由。只有显式注入 `legacyUpgrade` 的受信旧配置来源及经审查历史证据端口，才允许同一路由从 legacy 进入确认迁移；没有默认旧版白名单或历史证明。
- 设置编辑器只提交账号、回环监听、白名单、mention、启停等非秘密字段及 CAS 版本。主机分配配置版本和绑定现有安全凭据的随机代次；无 token/generation/path/key 输入。保存只是提案，不启动进程，不替换当前运行时。
- 启用提案必须匹配 active 凭据账号。禁用可以使用既有提案的代次，不因凭据损坏或不可用而无法停机。
- 操作预览固定 proposalId/revision，确认及异步边界重查。确认界面展示精确非秘密快照；另一窗口或主机源改变内容不能无声复用旧授权。
- 安全凭据仅在确认后的正确生命周期读取。真实适配器使用 Electron safeStorage，无 plaintext/混淆/basic_text 兜底。不存在自动导入旧 token 或 renderer 秘密 IPC。仅明确确认的受信旧版迁移会在主进程解读旧凭据并重加密写入新的安全 store。

## 受管进程证明

首次确认的 durable intent 写入后，才懒取得独占 owner epoch。每个 fork 之前持久化 dirty，再消耗一次性 grant；所有启动均走包装工厂。真实 utilityProcess `exit` 被登记，包括晚订阅的退出重放；kill 成功或 terminate Promise 结束不是退出证明。

恢复先停止当前实例，只有登记的全部受管实例实际退出后才能签发新 grant。激活前只能豁免本事务创建的那个实例。裸 manager.restart 不获新 grant，必须走显式恢复。禁用不保留可被工厂使用的 grant。

shutdown 先停止新请求、等待已确认操作、真实停止路由，随后写 clean-retired 并释放 lease。新主机仅能继承符合相同 scope 的 clean-retired 链；dirty/残锁/损坏/未知来源都保持阻断。任一生命周期或 ownership 目录存在都会阻止自动 fallback legacy。

这里的 driver 仅指该受管 Cyrene profile 的适配器/QFCA，不包括用户的 QQ 或 NapCat 客户端。代码不扫描或终止任意外部 QQ 进程，也不构成 OS sandbox。

## 已确认的试点边界与仍缺少的条件

用户已选择 Windows 小范围试点、host/module 配套签名发行、仅新安装及明确验证过的旧版升级。host 崩溃后拒绝自动恢复，异常由人工审查处理，不自动清锁。用户接受离线客户端不能即时获得撤销信息的延迟；这不允许跳过包期限、已知撤销或配套策略。

正式签名人、私钥保管人、初始 keyId/公钥尚未指定。实际分发渠道、正式支持矩阵与经过验收的旧 host 精确 artifact 清单仍需完成；不能拿 fixture key 或任意版本范围代替决定。现代码没有默认下载 URL、发行信任或升级许可。

历史 driver 缺席证明仍缺少真实安装器/受管 broker 提供者。首次纳管不能以新目录、端口空闲、PID 消失或用户按钮代替证据。当前测试仅对完全隔离且由测试拥有的 scope 使用合成证明。真实 Windows DPAPI/ACL、安装器历史证明、真实 QQ/NapCat 与异常退出人工处置仍需现场验收。

## 显式旧版迁移接线

`legacyUpgrade` 是 MAIN-only 组合，包含只读旧 settings reader 和 adoption 的精确 context、reviewed policy、exclusive historical scope provider。不接受 renderer 路径、版本白名单、信任根、token 或历史证明。

1. preview 只读取旧设置和已验证的当前账号/连接 epoch，绑定旧 host、新 host、模块 manifest SHA256、scope/session 及 settings digest。包 ID 必须与 context 的 module SHA256 对应。不会读出 token、冻结、停机或写 sidecar。
2. 明确账号确认后，先只读复核当前已选包及签名期限/信任、绑定的旧设置、账号/连接 epoch 和监听配置。包过期或预检拒绝时不写生命周期标记、凭据或提案，不停止旧驱动，可以安装新的有效包后重新预览。通过预检后在迁移锁内先持久化固定 `qq-module-adoption` 的意图，再写入新的凭据 envelope 和对应配置提案。已有新凭据或提案拒绝覆盖。旧 settings/history/bindings 保持不变。
3. 通用迁移协调器持久化 migration prepared，再调用受控 adoption wrapper。经审查的外部 scope 被冻结并证明历史未纳管 driver 缺席；同一个实际 router 完成 legacy listener close 与工作 drain，随后取得 ownership epoch 和一次性启动 grant。
4. 已验证包以隔离消息接收状态启动，核验实际账号与连接；在保存 selected 前重查旧 source、新提案/凭据代次、外部 lease 和已安装包的完整性/期限/信任。保存 selected 后才激活。
5. 开始持久化或尝试停机后的故障仍按原规则闭锁：不重启旧 driver，不清锁、不删除部分导入。写入新凭据/提案不等于迁移成功；prepared 或残留 sidecar 只表示需要审查。旧 stop 失败、导入失败或外部证据丢失会阻断重试或恢复，不自动覆盖导入。
6. 成功迁移的 canonical source 是 migration record，新安全凭据与提案支持随后显式恢复/重配；clean-retired 后新 host 仍需重新确认才能启动。dirty scope 不能通过新的 adoption proof 绕过。

此接线已用合成旧加密数据测试，不代表任何真实旧版本已经获准。正式 policy/provider 与现场验收缺失时保持未注入，不启用生产、不自动合并或发布。

## 隔离验证

单元/组合测试使用真实提案/凭据 envelope/所有权存储与管理器，仅进程边界为 synthetic peer；密码服务的 AES fixture 不等于 OS keychain。

`scripts/verify/qq-module/host-integration-electron.cjs` 使用完整签名离线 QFCA、实际 utilityProcess 和真实 owner exit 追踪，覆盖媒体、显式恢复、提案重配、禁用及 clean-retired 跨 host 继承。它会检查真实 Electron safeStorage：无可用安全后端时验证拒绝降级；组合链使用明确的临时 AES fixture，不能声称已验证 Windows DPAPI。运行命令见 host-integration.md。

`production-upgrade.test.ts` 覆盖真实 store/router/manager 的显式迁移组合，旧凭据为随机 AES 合成 fixture、模块边界为 FakeTransport；不能声称 Windows DPAPI 或真实历史进程证明已通过。`adoption-legacy-integration.test.ts` 另外覆盖真实 loopback listener 和合成 OneBot 的 current-host drain。
