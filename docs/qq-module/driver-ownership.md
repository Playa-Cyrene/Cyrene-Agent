# 封闭世界 driver ownership

`QqDriverOwnershipSupervisor` 管理同一 profile 中由 Cyrene 启动的 legacy QQ adapter / QFCA child；不管理、不要求关闭外部 QQ 或 NapCat 客户端。本文件不是进程发现算法，也不是 OS 沙箱或生产启用声明。

## 可信宿主组合契约

- `open({directory,scopeId,bootstrap?,legacy?})`：目录和 scope 只能来自宿主。使用 `wx` 创建排他 `owner.lock`。旧锁绝不自动删除；现存目录必须具有匹配 scope 的 `clean-retired` 记录，否则拒绝。
- 首次目录不存在时，必须提供经外部审查的 `bootstrap.verifyInitialScope()`，同步明确返回 `true`。这必须真实涵盖历史未纳管驱动，而非当前 PID/端口扫描。没有默认证明，也不能把用户点击确认当作 OS absence proof。失败会保留锁，后续不能绕过 bootstrap。
- 当前生产提案只允许已永久封闭 legacy 启动入口的模块 scope。不得因省略 `legacy` 就认为 legacy 历史不存在。首次 scope 的合法来源及发布策略仍需单独审查。
- 若接入 legacy，`stopAndDrain` 必须观察实际 listener close 和已接收工作 drain，并永久禁止所有旁路 legacy start。该端口仅证明已持有的实例，不证明历史 orphan。未覆盖全部 legacy 入口的组合不能启用混合模式。
- `await beginActivation()`：撤销旧 grant，持久化 dirty，完成 legacy proof，要求所有本 epoch 跟踪 child 已真实退出。返回对象身份、epoch、generation 绑定的一次性 grant。
- `wrapCreateTransport(create, grant)()`：先消耗 grant，预留同步 spawn 区段，持久化 dirty，再调用真实 transport factory。所有自动重启也必须重新申请 grant，不能重复调用旧工厂。
- transport 的 `onExit` 必须订阅真实底层 exit，并 replay 订阅前已经发生的 exit。不能拿 manager 状态或 `terminate()` resolve 代替观察。若 factory 或订阅抛错，即使可能尚未启动，也保守进入 unknown，禁止后续启动/clean retirement。
- `verifyAllStopped()` 仅证明该 scope 下受控实例全停，且无 launch/legacy proof 在途。`verifyNoOtherDrivers(transport)` 只允许显式传入本 supervisor 已跟踪实例作为唯一例外；陌生对象不构成豁免。
- `retire()` 仅在全停时写入 `clean-retired`，终止本对象的启动权限，然后释放 lease。调用退休即永久终止权限；即使仍有活跃 child、证明失败或写入失败，也不再允许申请 grant，并保留锁。下一个宿主只接受该 clean retirement 链。

## 持久化和限制

文件写入采用独占临时文件、文件 fsync、rename；POSIX 同步目录。Windows 的 Node API 没有这里可移植使用的目录 fsync，因此不声称跨平台掉电事务保证。该协议主要针对普通宿主进程崩溃及互斥重启；外部删除锁、篡改状态、同 OS 用户文件竞争、不遵守该协议的旧应用或其他 profile 别名均在证明范围之外。宿主必须选择唯一规范 profile/scope，所有驱动启动必须经过同一个 gate。

dirty、丢失状态、损坏状态、未知历史、创建结果不明、遗留锁均保持 blocked。不会因 PID 不存在、端口空闲、心跳超时、lease 过期就返回 true，也不会自动清锁。崩溃后的自动恢复需要可审查的外部 proof，或在启动前完成 native containment 的独立 broker；当前 JS supervisor 不提供它。

测试仅使用隔离临时目录和合成 transport，不启动真实 QQ、不读取凭据：

```sh
node node_modules/vitest/vitest.mjs run src/main/qq-modules/driver-ownership.test.ts
```
