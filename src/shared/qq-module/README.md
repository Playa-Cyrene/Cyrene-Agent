# QQ 专属契约候选（Phase 1）

本目录只有独立 JSON DTO、严格运行时校验和 API major/minor 协商。它不导入普通插件 SDK、Electron 或宿主渠道类型，也不下载、启动或信任模块。现有 NapCat 收发及 journal 语义保持不变。

- API `1.0` 是本次源码候选，不是已发布 SDK、QFCA Release 或宿主版本兼容承诺。实际实现只支持 `QQ_API_SUPPORT`；协商函数的其他版本测试只是算法夹具，不证明支持那些版本。新增 minor 字段需要各 minor 对应的校验及能力协商，不能绕过严格未知字段检查。
- 入站 conversation 必须显式区分 private/group。mentions 不接受 isBot，reply 只有一层。channel、会话和权限始终由宿主决定；DTO 结构检查不是白名单、账号或 epoch 授权检查。恶意模块可能谎报私聊，DTO 不构成 OS 沙箱。
- mediaId 仅允许 1–128 位 ASCII 字母、数字、下划线及连字符；不是路径或 URL。filename 是可选展示名称，禁止分隔符、盘符和控制字符。真实读写必须通过未来 broker 授权、限额和生命周期检查。当前没有媒体传输或持久化实现。
- 文本长度使用 UTF-16 code units；总 JSON 上限按 UTF-8 字节计算。未来传输层还必须在解析/克隆前限制帧大小，不能以这里的对象校验替代传输限额。时间戳为可转换为 Date 的非负整数毫秒；所有版本、epoch、revision、大小都是有界整数。
- 发送结果覆盖按顺序排列的所有请求 part。调用方必须将原请求传给 validateSendResult 做 operationId 和数量关联；仅验证结构时不能保证它对应某个真实请求。至少一个 unknown 时总结果 unknown；否则全成功为 sent，有成功有失败为 partial，全失败为 failed。unknown/partial 不可盲目重试。远端明确确认才可构造 sent；这需要未来运行时保障。
- `QqCapabilitySnapshot` 分离消息能力与后端专属 napcatStream 特性；显式布尔标记和大小限制不是权限授予，也不承诺真实后端探测/握手已经接入。能力上限不得超过契约上限，宿主还需按实际后端限制进一步收紧。
- `QqSendErrorCode` 是稳定无正文错误分类，不接受任意异常/堆栈。card 为受限字段，不暴露任意 JSON 或 OneBot action。

仍待实现：版本化进程 envelope/握手、凭据交接、专属管理器运行时、媒体 broker、真正模块、安装/迁移和回滚，以及运行时与 QQ 实测。公共 manifest、hostVersionRange、平台/架构兼容矩阵、发布者信任根、签名和安装信任政策均延期；不能通过 API 协商代替包兼容性或来源验证。当前没有经过验证的 QFCA 安装包或支持宿主版本范围。

验证：`pnpm exec vitest run src/shared/qq-module/contract.test.ts`，然后运行仓库 `pnpm run check:main` 等完整检查。

## 第二阶段运行时候选

`runtime.ts` 现在定义 hello/initialize/start/send/ackInbound/quiesce/stop/ping 和 status/inbound/capability-changed 私有 envelope；宿主运行时还未接入正常渠道启动。send 新增必填 connectionEpoch，需由宿主和模块发送边界双重核对。`QQ_RUNTIME_TIMEOUTS` 统一模块 120 秒总发送预算和宿主 130 秒响应等待，不能拿 5 秒控制 RPC 截断正常分片发送。详情、信任局限及测试见 `docs/design/2026-11-11-qq-module-host-runtime.md`。上文“仍待实现”描述的是第一阶段基线，不代表安装、媒体或生产切换现在已经完成。
