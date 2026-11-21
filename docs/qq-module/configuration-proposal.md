# QQ 主机侧非秘密配置提案

`configuration-proposal.ts` 是独立 sidecar，不修改旧 QQ 设置，不存储 Token，不启动、停止或激活任何驱动。提案不是用户授权或停止证明；生产 IPC 只能由另行审核的 host controller 调用，不能让 renderer 选择路径或写入凭据 generation。

## 主机 API

- `new QqConfigurationProposalStore(absoluteDedicatedRoot)`：由主机确定专用绝对目录。构造和空目录读取不写盘。
- `propose({config,enabled,credentialGeneration}, expectedRevision)`：严格校验完整 `QqRuntimeConfig`，额外要求数字回环监听。CAS 的初次 revision 是 `null`；后续必须匹配当前 revision。每次创建新的 UUID `proposalId`、单调递增提案 revision；输入的 `config.configRevision` 也必须严格增加，包括仅凭据或启停变化。
- `read()`：返回独立快照，缺失目录为 null；已创建但缺状态、损坏、未知 schema/文件、残留锁、软链接/硬链接均拒绝。
- `assertCurrent({proposalId,revision})`：严格绑定不可变预览。相同内容的新提案也使旧绑定过期。
- `readDesired(bindingOrUndefined, currentCredentialMetadata)`：提供 recovery lifecycle 的 desired 结构。启用时必须提供当前 `getMetadata()` 结果并匹配 active、账号与 generation；generation 映射到 `credentialRevision`，绝不把当前任意 Token 静默替换到旧提案。禁用时可以传 null，不依赖可用安全存储或解密，避免凭据故障阻止安全停用。
- `diffQqConfigurationProposals(previous,next)`：返回变更类别、目标账号/启停，以及完整非秘密 `before/after {config,enabled}`。不返回凭据 generation、Token、路径或密钥。

主机预览应保存 `{proposalId,revision}`，并在确认、停止旧驱动后、启动候选前及激活前重读/断言。仅在业务逻辑已用快照比较保证变化拒绝时才可不传绑定；同内容的新提案仍应使用绑定检测。generation 是安全凭据存储产生的 UUID，只由主机读取，不接受 renderer 自报。

状态采用独占锁、临时文件、fsync 和同目录 rename。rename 前失败保留旧状态；初次中断产生的残缺目录失败关闭，不自动清锁或恢复默认。单用户系统级恶意并发不属于这个文件层的安全沙箱。

## 验证

```sh
pnpm exec vitest run src/main/qq-modules/configuration-proposal.test.ts
pnpm run check:main
```

测试使用临时目录及合成账号，覆盖 CAS、不可变预览、两个 revision 的单调性、溢出、输入拒绝、credential metadata 不匹配/撤销、安全禁用、原子写失败、残锁、损坏、链接、返回值突变和非秘密 diff。此文件层测试不等于操作系统崩溃断电耐久性或 Windows 安装器验证。
