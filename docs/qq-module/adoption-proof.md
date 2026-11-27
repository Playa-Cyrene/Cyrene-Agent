# Windows 试点接管边界

本实现仍未启用生产，也不内置签名人、密钥或旧版白名单。范围仅为同一 managed profile 的 Cyrene legacy adapter 与 QFCA driver，不包括独立 QQ/NapCat 客户端。

## 实际实现

- `QqAdoptionIntentStore(userDataPath)` 在固定 `qq-module-adoption` 目录独占创建 `intent-lock` 与严格 `state.json`。只允许首次 prepared 写入，不覆盖、不解锁、不自动修复。文件 fsync + rename；POSIX 同步目录，Windows 不声称跨掉电的目录事务保证。任何残留目录都通过 startup recovery gate 阻断 legacy 自动启动。
- `createQqCurrentHostLegacyAdoptionPort(router, expectedIdentity)` 调用实际 router 的 `prepareMigrationStop`。该路由在 await 前冻结当前 legacy 启动和新输入，并将真实 adapter 的 listener-close、既有工作 drain 结果交回。成功或不确定 stop 后都不能自动回退 legacy。它不证明历史 orphan 不存在，也无法约束持有底层 adapter 的旁路调用者。
- `QqAdoptionProofCoordinator` 将异步、宿主专属证据转换为现有 ownership supervisor 的同步一次性 bootstrap。完整绑定 Windows 平台、scope、session、全新/已验证升级模式和精确旧 host/新 host/module SHA256。消费前重查上下文、策略、冻结 lease；取消只释放未消费证据。已消费证据永不复用，也不会因取消释放 scope。

## 必须由经审查宿主提供的缺口

`reviewedPolicy.approve` 必须根据实际已签名且验收过的精确 host/module 配对、升级源批准，而非随意填版本范围。当前未设置任何真实批准策略。

`exclusiveScope.freezeAndProve` 必须真实冻结所有启动入口并证明历史未纳管 driver 不存在（除明确跟踪且随后停止的当前 legacy 实例）。当前没有这个外部历史证明提供者。PID 不存在、端口空闲、版本字符串、文件不存在、用户点击、Electron single-instance lock 都不能代替证明。缺少提供者时不得调用 prepare，不得实现默认 `true`。

推荐宿主组合：构造 intent store，将 `persistIntent: context => store.persistIntent(context)` 注入 coordinator；先验证政策，再 durable prepared，再外部 scope proof，再当前 legacy stop/drain；production upgrade 在其 prepared 后、外部 stop 前导入新安全凭据/提案，保留旧数据不变；取得 proof 后用其 scopeId/bootstrap 调用 `QqDriverOwnershipSupervisor.open`。已有 dirty ownership/旧锁仍由 supervisor 拒绝，adoption 不绕过它。

已消费 scope lease 必须一直保留到对应 supervisor 已真实停止且 clean-retired、全部启动入口终止后。该 coordinator 故意没有“消费后释放”捷径，外部 broker/宿主负责有证据的终止交接。崩溃后一律 blocked，由人工审查处理，不自动清锁、不重放 prepared。

## 尚未交付的能力

旧版本资格清单、发布签名和 Windows 原生历史进程证明均未伪造。仅有当前 host 的真实 router 端口不代表任意旧安装可以升级。production-host 已提供显式 legacyUpgrade 的受控迁移组合，缺少 reviewed policy/history provider 时仍不可用；需要 Windows 实测，不能因接口存在就批准任意旧版本。

宿主必须在每次 prepare、fork、absence assertion 和 clean retirement 前检查 proof.isHeld()，不是只消费一次bootstrap。首次失败永久poison，不允许恢复原字符串后重用。证据丢失仍必须尝试停止实际进程，不可因检查失败跳过shutdown；但不能宣称clean retirement成功。消费后的lease本轮保留至宿主终止，没有便利释放API。未消费release仅放弃本次资源租用，不能重新打开被durable intent封住的legacy启动入口；这是外部端口必须遵守的契约。
