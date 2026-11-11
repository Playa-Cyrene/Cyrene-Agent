# QQ 安装、迁移与媒体候选集成

## 范围与固定输入

本增量仅在独立云端分支 `feat/qq-module-integration` 中组合既有候选，不合并远端 PR、不发布、不切换真实 QQ，也不关闭 #327。

- 宿主运行时 #339：`0f9480e26c6b9f75a274809c7aa949e63c1f564e`。
- 宿主媒体 #341：`ad758ec8376a436e22c8f6cb0ad7f078a80603ed`。
- 安装安全基础 #342：`a761b19e8cb73a563b114146a0fb1323646c3ae2`。
- 旧数据接管 #343：`9205248aa017b8b560a4e19df34b75d150e30259`，已含 #342。
- 配套 QFCA #2：`96c355b97ef81e33afc8da1e80784e7c4a865973`。

开始与结束均读取远端 heads，未用 PR 描述中的旧提交代替当前代码。合并采用 #343 + #341，保留原提交历史；两仓九个契约源码/测试文件及来源 SHA-256 一致。

## 冲突处理

`manager.ts` 同时保留：

- 独立数字 loopback 策略，不复用旧 adapter 允许 localhost/括号地址的策略。
- 显式宿主 media broker 与 chunked-v1 协商；没有 broker 保持文本路径。
- 持久提交前的 migrationQuarantine，禁止派发和主动发送。
- 回合 lease.active、实例、连接轮次及会话身份检查，防止迟到回复越过迁移或重连边界。

## 集成审查发现与修复

独立审查通过真实 QFCA 子进程和 loopback 假后端复现一个 P2：隔离期拒收事件只 ACK，模块已下载的附件没有释放。累积 256 个句柄后，激活后的合法附件也会丢失，直到 TTL 或断连清理。

宿主现在先有界释放拒收事件的 opaque handle，再 ACK；清理 Promise 参加排空。已接受事件的重复通知不能抢走首次下载的句柄，包括策略变化导致重复通知被改判为 rejected-policy 的情况。准备中授权撤销还会清理尚未交给 broker 的后续附件。清理不访问后端路径、宿主文件或 URL，不启动自动重试发送。

复审用真实子进程累计 257 次拒收验证句柄残留为 0，激活后的第 258 条附件正常。另验证重复事件首次下载完整交付、只释放一次。

## 组合回归

新增测试把临时签名惰性候选、真实 package store、迁移 sidecar、manager 与 media broker 组合运行：

- 提交前文本和媒体均隔离，提交后双向传输；stop 后已交历史的缓存保留。
- 旧 driver 排空证明前不创建新进程，活动文本回复可以结束，排空中的媒体准备取消。
- staged/committed 写入失败不泄漏媒体、不重启旧 driver、不在重启读取时重放。
- 确认前/排空后撤钥、安装文件篡改均重新验证，原设置/历史/绑定保持。
- detached lease、撤销时未开始的附件、迟到下载、原始 partIndex 与 unknown 语义保持。

原 NapCat 集成测试现同时覆盖真实旧监听关闭、完整 handler/最后回复排空、提交前文本及附件隔离、提交后媒体、实际 SQLite transcript/绑定/日志读取与原文件不变。

真实 QFCA 测试在 stage → activate 后发送实际 100 MiB，核对 1600 个 IPC/backend 块与完整 SHA-256。容量测试遵守后端 64 事件排队上限，逐条等待 ACK，测累计保留而非队列溢出。每个真实子进程使用测试专用临时目录，避免多个隔离执行会话共享系统临时目录产生 PID 归属干扰。Node 测试 transport 将异步 error 转交 runtime，与生产 fatal-error 路径一致。

## 可复现命令

环境：Node 24.22.1、pnpm 10.33.0、Linux。仅临时假数据、假后端与受审查的本地 QFCA 编译入口。

```sh
# 在 QFCA 固定提交副本内
npm run verify
npm pack --dry-run

# 在本仓集成分支内；请替换成受审查的 QFCA 副本绝对路径
QFCA_ENTRY=/absolute/path/to/QFCA/dist/runtime/entry.js QFCA_LARGE_MEDIA_TEST=1 \
  pnpm exec vitest run src/main/qq-modules src/main/channels src/plugins src/shared \
  src/renderer/react/features/settings/ChannelsSettingsMigration.test.ts
pnpm run check:main
pnpm run check:preload
pnpm run check:renderer
pnpm run build
pnpm test
```

扩展定向回归：84 文件、1046 项通过，1 项 Windows-only 跳过；包含真实跨仓容量与 100 MiB。QFCA 精确头 verify：305 项、类型检查、构建、编译 IPC smoke 通过；pack dry-run 通过。独立复审未确认剩余缺陷。

最终代码上的 main/preload/renderer 类型检查与完整 build 通过，保留已有大 chunk/jsdom 提示。全仓结果为 623 文件通过、5 失败、8 跳过；7199 项通过、8 失败、43 跳过。8 项失败为 7 项截图 Windows 路径假设与 1 项后台 shell PID；已在独立干净 #339 `0f9480e` 工作树重跑这 5 个文件，复现完全相同的 8 项失败，不声称全仓全绿。没有本地 QFCA 入口时全仓命令会跳过跨仓测试；上面的显式入口定向命令已另行运行。

## 未完成与生产限制

生产安装、下载、迁移和启动编排仍关闭，installation-status 仍返回 release-unconfigured / canInstall=false；原 init.ts 继续注册内建 NapCatAdapter。测试每次生成的短期密钥只验证临时惰性包，绝不作为生产信任根。没有伪造正式发行包、发布者、公钥信任或支持矩阵。

仍未完成生产签名/撤钥/下载器、崩溃残留锁与孤儿进程安全恢复、Windows/Electron utilityProcess/ACL/安装包验收、真实 QQ/NapCat 收发、默认包去除旧 QQ 实现。保留旧文件不等于完整备份；同卷 rename/fsync 不构成断电级保证，独立进程不是 OS 沙箱。远端没有本集成分支或对应 CI，本地通过不表示远端 CI 通过。
