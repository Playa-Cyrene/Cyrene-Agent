# QQ 受控操作网关的主机接线契约

共享 DTO 位于 `src/shared/qq-module-actions.ts`。`QqModuleActionGateway` 是可复用的异步校验/归属边界，不自行创建服务或启用生产。

```ts
const gateway = new QqModuleActionGateway(trustedService); // 无服务时省略参数，始终 unconfigured
// 主机必须先从可信 IPC event 验证 sender/frame/origin，再选择稳定的 owner 对象。
await gateway.execute(rendererInput, {
  key: hostOwnedWindowSessionObject,
  isAuthorized: () => senderIsStillTheTrustedLiveOwner(),
});
// 窗口销毁、导航离开可信页面或所有权改变：
await gateway.invalidate(hostOwnedWindowSessionObject);
```

- `key` 必须是主机维护的稳定对象，不得从 payload 的 ownerId、窗口 ID 或其他 renderer 字段构造。可信页面重建后应生成新的会话对象，已 invalidated 的对象永不恢复授权。
- `isAuthorized` 每次调用和异步返回后都会再查；需验证实际 sender 尚存、所属窗口、允许的 frame 和受信 origin。网页声称自己可信不是验证。
- 主机对整个 QQ 操作服务只维护一个 gateway；不能为每次 IPC 请求新建实例绕过归属和互斥。
- 默认没有 port 时不检查 payload 或 sender，不调用任何服务，直接返回 `unconfigured`。
- 输入采用严格字段白名单；不接受 URL、路径、公钥、凭证、候选字节或 owner。确认必须匹配当前操作 ID、操作类型及账号，并明确 `userConfirmed:true`。
- 未确认预览绑定来源 owner；其他窗口可以查询安全 status/read-configuration，但不能覆盖、确认或取消。新预览取代旧预览，已消费/取消 ID 不可再次确认。
- 异步操作串行化；重复点击及期间其他操作返回 `busy`。窗口销毁后的迟到 preview 会由主机清理，不能交回旧窗口。
- 销毁/失效只清理尚未开始的 preview。已经确认的迁移可能已经停止旧驱动或写盘，不能假装取消。失效窗口不会收到成功结果；主机必须通过服务的持久化和实际运行状态呈现恢复/结果。
- 自动清理失败时 gateway fail-closed 返回 `recovery-required`，不能通过换窗口继续动作。
- port 不得接收原始 event 或 renderer 权限对象。所有异常消息/栈均被丢弃；返回结果也通过字段白名单验证，意外携带 token/path 等会变成 `operation-failed`。

`status` 的成功结果是 `ready`、`committed`、`disabled` 或 `recovery-required`；其中 `committed` 必须由服务查询当前实际 driver 活性得出，不能由磁盘标记或缓存历史结果代替。不携带候选秘密。具体操作可行性由服务再次验证。所有 preview 返回 `operationId/packageId`，迁移/首次配置附已确认账号，安装可附版本。不要将该最小 DTO 扩展为原始 settings 或主机路径传输通道。

`read-configuration` 返回严格非秘密提案视图；`propose-configuration` 仅接受有界的运行配置、enabled 和 expectedRevision，不接受凭据或代次。保存提案不是启用授权，有待确认的 runtime preview 必须先取消，不能在其间改提案。主机提供 CAS 和配置版本，不信任 renderer 版本值。运行预览可携带精确非秘密 configuration，必须与确认账号匹配，以便用户看清实际将应用的监听/白名单等值。

验证：

```sh
pnpm exec vitest run src/main/qq-modules/action-gateway.test.ts
pnpm run check:main
```

这些测试使用注入服务端口，覆盖字段白名单、所有权、重复确认、取消、乱序异步、窗口失效与失败清理。真实 Electron sender/frame 绑定和完整 UI 仍须由实际接线测试验证。
