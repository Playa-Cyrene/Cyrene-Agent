# QQ 可选模块：主机侧安装/迁移编排演练

`src/main/qq-modules/installation-controller.ts` 是可测试的主机组合入口，**不是已开放的产品安装 API**。生产仍使用 `installation-status.ts`，保持 `release-unconfigured`、`canInstall: false` 和 `legacy-builtin`。本实现不配置发行信任根、不下载包、不自动启动模块、不接触实际 QQ 账号。

## 为什么需要这一层

原来的 package store 和 migration coordinator 分别处理包原子选择及驱动切换。调用者仍需自行解决两阶段 UI 的预览失效、关闭取消、重复点击、并发切换及“确认后包已换掉”的问题。本控制器将这些规则集中在单个 host session：

- 构造时不提供 host，就拒绝所有动作，且不检查候选内容、不创建存储、不停止驱动。
- `previewInstallation(bytes)` 只允许可信主进程调用；用 host 的验证上下文校验候选，再复制已验证的字节。返回不透明操作 ID、包 ID 和版本，不返回路径/公钥/凭证。
- `confirmInstallation({operationId, userConfirmed:true})` 一次性消费预览，由真实 `QqPackageStore.install` 再查当前信任、到期时间及防重放。只安装，不启动。
- `previewMigration()` 只选当前 store 中重新验证的包，不接收 renderer 包 ID。委托真实 coordinator 获取账号和配置预览。
- `confirmMigration({previewId, accountId, userConfirmed:true})` 先重新验证当前选中包仍匹配，再委托 coordinator。所有其他动作在该异步操作结束前返回 `operation-busy`。
- `cancel({operationId})` 只能撤销尚未开始的预览。排空旧驱动/写盘/启动新进程开始后，不能把关闭弹窗当成成功取消。
- 新预览会撤销旧预览；新预览失败也不会恢复旧确认资格。执行过的确认不能重放。
- `getState()` 仅表示这个控制器的会话操作状态，`idle` **不表示驱动停止或已运行**。不缓存 `committed` 结果作为运行证明。重启后必须使用现有 migration 恢复语义。

## 隔离测试中的组合契约

`installation-controller.test.ts` 使用临时目录、运行时生成的 Ed25519 测试密钥、惰性不可执行包内容、模拟 QQ 账号和 FakeTransport；但 package store、migration store、migration coordinator 及 manager 都是真实实现。

可信 host 必须独占一个 controller 和 coordinator，并保证：

1. `packages` 的验证上下文和 `verificationContext()` 来自同一 host 信任策略；不能采用包或 renderer 提供的公钥。
2. coordinator 的 `verifyCandidate(packageId)` 必须重新验证 store 中精确候选，不能空实现。测试示例比较重新验证的 `getSelected().packageId`。
3. `createModule()` 是无启动副作用的可信工厂；只有 coordinator 能调用其隔离启动和激活步骤。
4. 不能把这些内部对象、候选字节接收方法或原始错误对象直接暴露到 renderer。后续 IPC 只能接收严格的操作 ID/账号确认，并映射经过审查的错误码；未知异常统一失败，不能发送栈、路径或密钥环错误。
5. 不得创建多个 facade 绕过会话互斥；持久化 store 的锁仍是底线，而不是多个 UI 会话并发修改的授权。

运行定向测试：

```sh
pnpm exec vitest run src/main/qq-modules/installation-controller.test.ts src/main/qq-modules/package-installation.test.ts src/main/qq-modules/migration.test.ts src/main/qq-modules/migration-recovery.test.ts
pnpm run check:main
```

## 尚未完成、禁止据此开放生产的部分

- 正式发行信任根、受审查的支持矩阵、候选取得方式与发布流程。
- package store 校验后解析执行入口的 host-only 接口；当前 controller 不执行已安装包。
- QQ channel adapter/dispatcher 唯一驱动所有权；现在 `channels/init.ts` 仍默认注册旧 NapCat adapter。
- 应用重启时读取迁移标记后的恢复门控。`selected` 不是活进程证明，不能自动启动两个驱动或重放操作。
- 新用户首次配置路径。现有迁移只适用于旧 QQ 已启用且有已确认在线身份的用户；无历史数据不应被迫伪造旧账号。
- 产品 IPC、UI 状态机及关闭/重开/乱序响应的真实 UI 验收。
- Windows 密钥环、安装器/文件锁/替换/重启行为和真实 NapCat 联调。Linux mock 测试通过不能代替这些验收。

这些缺口尚存时，本编排层只能作为分支中的离线演练基础，不应打开生产安装按钮或声称整条安装/迁移链已完成。
