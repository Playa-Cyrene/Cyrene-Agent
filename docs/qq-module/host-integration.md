# QQ 安装、首次配置与显式恢复集成验收

当前分支已组合签名包存储、受信运行工厂、单一 QQ 路由、迁移、独立首次配置、持久恢复门控、操作 IPC 与设置确认界面。**生产没有注入发行信任配置，默认仍不可安装/激活**。不要从测试通过推导出正式发行授权。

新增配置提案、安全凭据和受管进程所有权组合，详见 [production-host.md](./production-host.md)。下述通用服务仍可独立演练；最新真实 Electron 脚本使用新的受控组合。

## 主机组合

initializeChannels 的 configureQqRouting(router) 是仅主进程可用的组合点，可返回：
- port：QqModuleHostService，所有安装、迁移、首次配置、恢复和配置变更操作共用互斥。
- isTrustedSender(event)：经审查的主窗口授权策略；无默认放行。IPC 还核对主 frame、导航/销毁及预览归属。
- shutdown()：调用 service.shutdown，阻止新操作并等待已确认工作，最后停止唯一路由。

服务要求 host 提供固定用户目录、可信公钥/支持矩阵/时间策略、已审查本地候选、原设置读取、安全凭据读取和旧驱动不存在的证明。这些均不能由 renderer、公钥文件、环境开关或包自身指定。当前应用默认没有传入此组合，不会自动下载或启用。首次配置仅允许 renderer 指定数字预期账号，主机从可信配置源构造监听/白名单，启动后验证实际账号。

生命周期 sidecar 使用固定子目录 qq-module-migration / qq-module-first-setup / qq-module-recovery。任意记录（含 rolled-back）、残留锁或不安全/不可读取路径都会阻止普通 startAll 恢复 QQ；磁盘选择不是活进程证明。首次配置在撤销路由/异步不存在证明前先写 prepared。UI 不提供自动清锁、自动回退或自动重试未知发送。模块已接管或恢复受阻时，旧QQ设置写入会被明确拒绝，不能把未应用的白名单/禁用修改误报为生效；其他渠道设置不受影响。显式恢复和配置变更由独立 lifecycle 主机绑定提供，缺少此绑定时不可用，不会偷偷用旧设置重新启动。

## 恢复和受控配置变更

lifecycle 绑定仅由主进程提供：readDesired(baseline)、readCredential(snapshot)、verifyAllDriversStopped() 和 verifyNoOtherDrivers()。配置与非秘密凭据代号来自安全的主机源，不能由 renderer 上传。初次历史记录没有凭据代号时，在显式操作预览绑定当前代号；后续变更必须走重配。凭据代号不得为token、token摘要或其他秘密派生值。

恢复只复用已确认的账号/配置/选定包，重新验证签名、支持矩阵、有效期、凭据代号与实际账号。重配可以改变白名单、启停、账号、监听或凭据代号，但先预览明确变更类别并手输目标账号确认。配置变化必须提高 configRevision。不支持热替换：排空停止旧进程、独立全驱动停机证明、隔离启动新进程、实际身份验证、持久化选择之后再接入。禁用只持久化和停止，不读凭据、不启动进程，包授权失效不能阻止禁用。禁用后的普通恢复不会重新启用，必须再次明确重配。

prepared 在任何停止/证明之前保存。未完成事务、残留锁、损坏/矛盾来源拒绝猜测，不自动清理。正常完成的 selected/disabled 只作为下一次显式操作的基线，不证明当前存活。失败的 desired 不取代之前的 canonical 配置，未知发送不重放。普通 stop 后可明确恢复；应用 shutdown 后该主机服务和路由实例永久拒绝新操作。

ALL-driver证明必须覆盖旧模块、legacy监听和前一主机残留进程；“端口暂时不可连”“找不到PID”“已选中磁盘记录”单独都不够。启动新隔离模块后的 no-other-driver 证明与全停机证明分开。当前生产未提供这些证明来源，不能把合成测试的 true 当作正式实现。

## 可复现的真实 Electron 离线验收

只运行独立云端/测试 checkout，不启动主应用，不使用真实 QQ、账号或聊天数据。先在已审查的 QFCA checkout 安装锁定依赖并构建离线演练候选：

    QFCA_NPM_CACHE=/absolute/cache npm run release:prepare -- scripts/release/rehearsal-plan.json /absolute/qfca-unsigned.json

在 host checkout 安装锁定依赖和官方 Electron，执行：

    pnpm run build:main
    QFCA_UNSIGNED_CANDIDATE=/absolute/qfca-unsigned.json node_modules/electron/dist/electron --headless --ozone-platform=headless scripts/verify/qq-module/host-integration-electron.cjs

脚本使用进程内一次性 Ed25519 密钥、演练时钟1500、显式候选版本0.0.0及本机platform/arch，仅是测试信任。没有密钥持久化或正式签名发行。原演练计划为linux/x64，其他平台需单独准备审查后的对应演练计划；不可宣称该命令覆盖Windows。

验收链：gateway预览/确认 → 安装真实完整依赖闭包 → resolver重验 → 实际utilityProcess → 首次配置实际账号验证 → 持久选择 → 路由入站。随后测试早到PNG探测等待与文本顺序/去重、1MiB文件、重连旧任务拒发、崩溃未知发送、gateway显式恢复与新进程账号重验、不重放、受控白名单变更后撤销旧用户、确认禁用和拒绝隐式重新启用。

最新脚本的凭据加密使用明确的临时 AES fixture，真实 safeStorage 不可用时验证失败关闭；全停机由真实 utilityProcess 退出追踪，首次历史边界仅使用隔离 fixture 的明确 bootstrap。**这不验证真实Windows密钥环/ACL、真实NapCat或安装器/升级流程**。真实桌面截图交互与签名发行政策仍需验收。满足这些条件前保持草稿分支，不合并或发布。
