# QQ 专属宿主运行时（第二阶段候选）

## 依赖和当前边界

本增量以未合并 Draft PR #338 的 `46b27ce9b95f3254621df2238d3bb97554edfefa` 为基线，不能作为独立于该 PR 的补丁合并。它不关闭 #327，不发布模块或 SDK，不改变普通插件加载器。

新增 `QqModuleManager`、固定 `id="qq"` 的 `QqModuleAdapter`、版本化私有进程消息和 Electron utility-process 工厂。**尚未接入 `initializeChannels`**：原 `NapCatAdapter`、官方 QQ、配置、绑定、journal、权限和普通用户收发完全保持原路径。没有自动下载、安装器、持久账号确认、迁移 UI、媒体 broker 或默认加载 QFCA。启用装配必须等信任与迁移后续步骤完成，不能将此候选当成完整可选模块功能。

`src/shared/qq-module/` 是与 QFCA 共用的唯一候选契约源。QFCA 复制该目录并记录来源，不各自设计另一个 envelope。为堵住跨进程重连窗口，本增量对仍未发布的 1.0 候选添加了**必填 `send.connectionEpoch`**；旧第一阶段 send 夹具需要同步，不能默认为当前连接。

## 握手与消息

每个 envelope 包含固定候选 `apiVersion`、随机 `instanceId`、递增 `runtimeEpoch`，并明确 request/response/event。请求使用 `requestId`，响应使用 `responseTo`；未知方法/字段、错版本、越界 payload 关闭协议，旧代次及重复终态丢弃。收到端严格检查 JSON、结构和响应与原 send 的 operation/part 数量关联。

顺序为：`hello` → API 支持协商 → `initialize` → `start`。不兼容 hello 不释放 token。配置与 token 仅在父子私有 IPC 交接，token 不在环境、argv、状态或错误正文中。`expectedSelfId` 必填，必须来自未来宿主确认流程；这里不会将首次看到的账号自动作为旧历史所属账号。当前 QFCA 后端另外要求已解析 IP 和数字 QQ 账号，宿主未来装配要先规范化旧 localhost/custom 配置。

模块发布 `status`、`inbound` 和 `capability-changed`。start 期间的最新 status 优先于可能较旧的 start 响应，start 完成前不接受入站。`ackInbound.accepted` 仅表示已接收进处理，不表示落盘或回复完成；ACK 丢失不触发重放。

## 宿主持有的边界

- 宿主在入站最终复核账号、连接 epoch、配置 revision、私聊身份一致性、白名单及群 @ 策略。`channel="qq"`、Date、`mentions.isBot` 由宿主构造，不接收模块的权限、会话、路径或 `_raw`。
- 当前媒体 broker 未实现，任何入站附件或出站本地路径/URL/媒体均明确拒绝，不向模块传主机路径。能力对媒体强制 false；文字、card、reply/mention 和文字长度还按模块当前能力检查。QFCA 本轮只实际支持文字/reply/mention，card=false。
- 白名单可在宿主即时撤销，旧 module config snapshot 不能绕过最新策略。监听或账号变更必须重启，而不是借更新白名单切换账号。
- 完整 dispatcher Promise 在 AsyncLocalStorage 中绑定 runtime、connection 和目标会话；stop 拒新入站，quiesce 后旧轮次仍可发送。排空超时即撤销旧授权，旧异步结果不能经新进程或新连接发送。模块接收以及真正发送时还必须核对 `connectionEpoch`，不能只靠宿主发送前检查。
- 每实例最多 16 个入站处理、64 个未完成 RPC、1024 个 eventId 去重记录。去重是有界短期防重复，不宣称 exactly-once 或崩溃后的可靠重投。没有另外创建 agent 业务队列，也不假装已有 agent AbortSignal。
- `QqModuleAdapter.send` 保留原部分成功 `ok:true` 兼容映射；精确 sent/partial/failed/unknown 可从 manager 取得。没有在搬迁中偷偷改变 journal 状态语义。已交给进程后的超时/断线/协议失效保守记 unknown，不自动重发。

## 时间与进程退出

统一常量 `QQ_RUNTIME_TIMEOUTS` 定义控制 RPC 5 秒、模块 send 总预算 120 秒、宿主 send 响应 130 秒。QFCA 的预算包含排队、分片及后端 action，耗尽后不得继续发送尚未发送片段；宿主留出结果传回余量。测试可显式注入短预算，不能以控制 RPC 的 5 秒代替文字分片发送预算。关闭默认总排空期仍为 5 秒；用户明确停止时的未确认发送可能成为 unknown。

`utilityProcess.kill()` 是请求退出，不是退出证据。RPC 关闭会先收敛 pending，但 manager 只有确认子进程 exit 才释放其运行槽。工厂等待 graceful exit，1 秒仍未退出则返回终止失败并保留旧槽，**阻止 restart 创建重叠进程**。当前不实现平台强杀；真实进程挂死可能需要用户关闭应用/系统处理，不能声称已完整终止。晚到的真实 exit 可解除此阻塞。

Electron V8 fatal `error` 事件有独立监听并关闭运行时，不把报告内容向主进程错误日志透传，也不触发无监听 EventEmitter 异常。环境是显式白名单，并含固定非敏感 sentinel，避免部分 Electron 版本对空 env map 回退继承全环境；不接受任意 execArgv。

## 信任局限

此进程隔离崩溃和阻塞，**不是 OS 沙箱**。Node 子进程仍有用户级磁盘与网络能力。入口检查只做真实路径目录约束，不能替代来源、hash、签名、安装版本兼容验证。工厂仅可由可信宿主组合代码传入已确认包，未暴露 renderer IPC。

Electron structured-clone IPC 已经在接收端 JS 之前分配消息对象，因此当前 JSON/256 KiB 检查属于**收到后限界**，不保证在解码或分配前阻止恶意巨帧。不要把消息 schema、白名单环境或进程独立性宣传为恶意第三方代码的强隔离。启用前仍需包信任政策及媒体/安装资源限额设计。

## 验证方式

- `pnpm exec vitest run src/shared/qq-module src/main/qq-modules`：包含严格契约、fake transport、真正 Node fork 的网络隔离 fake 子进程、生命周期、账号/白名单、退出失败、迟到消息等。
- `QFCA_ENTRY=/absolute/reviewed/qfca/dist/runtime/entry.js pnpm exec vitest run src/main/qq-modules/qfca-compatibility.test.ts`：显式选择已审查、已构建的 QFCA 候选；私有父子 IPC 加 loopback fake OneBot WebSocket。未指定路径时明确跳过，绝不自动下载执行。
- CI 新增 QQ 专属运行时测试组，从 main/core 排除以免重复；契约测试仍由 shared 组覆盖。
- 继续运行渠道/插件回归、check:main/check:preload/check:renderer 和完整 build。

本轮 Linux Node 子进程/fake WS 通过不等于 Electron 实物包或真实 QQ 收发通过。Windows utility-process 打包路径、reparse point、签名/安装与退出 smoke、真实 QQ 账号/媒体，以及完整迁移仍是后续验收项。
