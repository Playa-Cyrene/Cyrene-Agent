# QQ 可选模块：第一阶段宿主基础

关联 [RFC #327](https://github.com/Playa-Cyrene/Cyrene-Agent/issues/327)。本次只落地可独立验证的契约和宿主兼容边界，不表示完成 QQ 模块拆分。

## 本次实现

1. `src/shared/qq-module/` 定义独立 JSON DTO、严格输入校验及 API major/minor 协商候选。入站包含明确的私聊/群聊、mentions、一层 reply；出站包含 replyContext、媒体句柄和分片结果。它不依赖普通插件 SDK，也不暴露渠道身份、会话、LLM、工具或工作区 API。
2. `ChannelManager` 提供普通插件窄端口，宿主专属 `qq` / `qqbot` 即使暂未注册也不能被其占用。端口持有宿主生成的归属令牌，不能注销另一端口或宿主的 adapter。插件运行时继续用现有资源跟踪维护插件间归属，QQ 模块不经此端口加载。
3. 所有 adapter 入站消息必须匹配注册身份，已注销实例保存的旧回调不能再注入。此检查不声称能验证外部平台消息真假，也不改变群聊禁工具和绑定工作区隔离策略。
4. QQ 地址解析、回环判定和 token 预检迁到 `src/main/channels/qq-listen-policy.ts`。设置 IPC 不再依赖 OneBot 后端；旧反向 WS 导出保留为同一函数的兼容别名，实际监听与设置预检仍共用一套规则。

既有 NapCatAdapter 和官方 QqBotAdapter 仍由宿主正常注册。旧 `qq` 身份、配置默认值（包括 auto/WSL 行为）、token 存储、白名单、会话键、绑定、journal 和发送回执语义均不迁移。此次没有新增下载、安装、启动 QFCA 或清理数据的行为，也没有更改原 QQ 设置 UI。

## 候选契约与实际运行的区别

目前仅实现候选 API `1.0` 的类型和验证器，不是已发布 SDK。API 兼容不等于主程序版本、发布包或后端兼容。其他 major/minor 的测试只检查协商算法，不宣称支持那些版本。

DTO 是进程协议的一部分，后续需添加带 instanceId/runtimeEpoch 的版本化 envelope、凭据交接、结构验证后的宿主策略和实际传输。运行时必须在反序列化前限制帧大小，验证账号与代次、白名单及群 @ 规则，再由固定 QQ 宿主代理映射到现有 IncomingMessage。mediaId 的语法检查不等于授权；媒体 broker 必须检查实例、用途、大小和存活时间，不能直接读模块提供的路径。

新的 sent/partial/failed/unknown DTO 不接入现有 dispatcher/journal，本次不会暗改旧的 `ok` 回执映射，也不会增加自动重发。

## 后续独立 PR 的门槛

- 固定 QQ 宿主代理与专属 QqModuleManager：旧实现作为过渡 driver，不双注册；停机追踪完整 dispatcher 在途轮次，拒绝旧实例迟到发送。现有队列没有 drain，不能假定已具备。
- QFCA 迁入连接/协议/媒体实现，并以同一 fixture 验证文本、媒体、@、引用、白名单的等价行为；官方 QQ 留在主仓。
- 可信发布者与签名信任根、归档校验、安装事务、回滚、hostVersionRange 和平台矩阵须确定并实测后才能开放安装。不能仅靠模块自报 ID 或版本获得 `qq` 身份。
- 原 QQ 设置区增加安装/状态/迁移入口，保持宿主数据。旧会话键不含 selfId，因此需确认原账号并锁定；不在搬迁时悄悄支持换号复用历史。
- 可用 QFCA 包、迁移/卸载/恢复、真实 Windows 收发及安装包内容检查全部通过后，才能另行移除内建实现并达成“默认包不带 QQ 模块”。本 PR 不声称已达成该验收。

独立进程不是强安全沙箱；发布来源和模块自身代码仍须可信。普通插件的同进程 API 限制也不能当作抵御任意恶意本机代码的安全承诺。

## 可复现检查

使用仓库指定 Node 24、pnpm 10.33.0：

```sh
pnpm install --frozen-lockfile
pnpm exec vitest run src/shared/qq-module src/main/channels/manager.test.ts src/main/channels/qq-listen-policy.test.ts src/main/channels/adapters/qq/onebot-listen-auth.test.ts src/main/channels/adapters/qq/onebot-reverse-ws.test.ts
pnpm exec vitest run src/main/channels src/plugins src/shared
pnpm run check:main
pnpm run check:preload
pnpm run check:renderer
pnpm run build
```

新增测试位于现有 Vitest 与 CI 已包含的 src/shared/src/main/channels 范围，不沿用暂时排除的 plugin-sdk 包测试路径。
