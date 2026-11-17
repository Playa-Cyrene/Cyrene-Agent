# QQ 安装与首次配置集成验收

当前分支已组合签名包存储、受信运行工厂、单一 QQ 路由、迁移、独立首次配置、持久恢复门控、操作 IPC 与设置确认界面。**生产没有注入发行信任配置，默认仍不可安装/激活**。不要从测试通过推导出正式发行授权。

## 主机组合

initializeChannels 的 configureQqRouting(router) 是仅主进程可用的组合点，可返回：
- port：QqModuleHostService，所有安装、迁移与首次配置操作共用互斥。
- isTrustedSender(event)：经审查的主窗口授权策略；无默认放行。IPC 还核对主 frame、导航/销毁及预览归属。
- shutdown()：调用 service.shutdown，阻止新操作并等待已确认工作，最后停止唯一路由。

服务要求 host 提供固定用户目录、可信公钥/支持矩阵/时间策略、已审查本地候选、原设置读取、安全凭据读取和旧驱动不存在的证明。这些均不能由 renderer、公钥文件、环境开关或包自身指定。当前应用默认没有传入此组合，不会自动下载或启用。首次配置仅允许 renderer 指定数字预期账号，主机从可信配置源构造监听/白名单，启动后验证实际账号。

生命周期 sidecar 使用固定子目录 qq-module-migration / qq-module-first-setup。任意记录（含 rolled-back）、残留锁或不安全/不可读取路径都会阻止普通 startAll 恢复 QQ；磁盘选择不是活进程证明。首次配置在撤销路由/异步不存在证明前先写 prepared。UI 不提供自动清锁、自动回退或自动重试未知发送。模块已接管或恢复受阻时，旧QQ设置写入会被明确拒绝，不能把未应用的白名单/禁用修改误报为生效；其他渠道设置不受影响。模块动态配置及正常重启后的显式恢复/重新激活尚需单独完成，不会偷偷用旧设置重新启动。

## 可复现的真实 Electron 离线验收

只运行独立云端/测试 checkout，不启动主应用，不使用真实 QQ、账号或聊天数据。先在已审查的 QFCA checkout 安装锁定依赖并构建离线演练候选：

    QFCA_NPM_CACHE=/absolute/cache npm run release:prepare -- scripts/release/rehearsal-plan.json /absolute/qfca-unsigned.json

在 host checkout 安装锁定依赖和官方 Electron，执行：

    pnpm run build:main
    QFCA_UNSIGNED_CANDIDATE=/absolute/qfca-unsigned.json node_modules/electron/dist/electron --headless --ozone-platform=headless scripts/verify/qq-module/host-integration-electron.cjs

脚本使用进程内一次性 Ed25519 密钥、演练时钟1500、显式候选版本0.0.0及本机platform/arch，仅是测试信任。没有密钥持久化或正式签名发行。原演练计划为linux/x64，其他平台需单独准备审查后的对应演练计划；不可宣称该命令覆盖Windows。

验收链：gateway预览/确认 → 安装真实完整依赖闭包 → resolver重验 → 实际utilityProcess → 首次配置实际账号验证 → 持久选择 → 路由入站。随后测试早到PNG探测等待与文本顺序/去重、1MiB文件、重连旧任务拒发、崩溃未知发送、显式底层runtime重启及不重放、确认停机。底层runtime重启是诊断操作，不是产品IPC提供的恢复授权。

安全存储与旧驱动不存在证明由合成测试端口提供；**这不验证真实Windows密钥环/ACL、真实NapCat或安装器/升级流程**。真实桌面截图交互与签名发行政策仍需验收。满足这些条件前保持草稿分支，不合并或发布。
