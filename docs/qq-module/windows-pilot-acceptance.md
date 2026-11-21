# QQ Windows 首版试用验收

## 已确认的产品边界

首版 Windows 小范围测试；模块随主程序安装包配套签名交付，只支持可证明的新安装和明确验收过的旧版本升级。主程序异常退出阻止自动恢复，保留记录供人工核查，不自动清锁；接受离线客户端获知撤销的延迟以及异常退出不是无感恢复。

以上不是发行许可或验收结果。正式签名负责人、公钥和私钥托管仍需发布前确定。本分支不设置正式密钥、不启用生产、不自动合并或发布。测试中产生的一次性签名密钥只在内存使用。

## 精确证据而非版本推断

- 发行组合必须固定 host 版本/Windows 架构、模块 manifest digest、版本、序号与 keyId。已安装包读回同样检查 exact manifest pin。
- 首次纳管需要独立可信的历史来源及所有启动入口冻结证明。新目录、空闲端口、未查到 PID 和用户按钮本身都不是证明。
- 当前 host 的真实旧路由端口只证明自己持有的 listener/accepted turns 已关闭/排空，不能证明历史孤儿或其他软件实例不存在。
- 永久 adoption intent 只是副作用开始前的阻断记录，不是进程退出证明或可自动恢复的令牌。
- 升级支持列表应记录精确旧产物 hash、目标 host hash、模块 hash 和平台。没有真实验收过的来源不得加入正式列表；没有默认放行列表。

## 四道验收门

1. **隔离 Windows profile + 合成 OneBot**：最终安装产物、DPAPI 保存/读取/重启、跨 Windows 用户读取拒绝、ACL、拒绝不安全后端、密文损坏、凭据轮换。确认 token 不出现在日志、renderer 状态或错误内容。DPAPI 不防同一用户下其他程序。
2. **升级与中断矩阵**：对每个声明支持的旧版本，检查普通/便携安装、多实例、旧版重启、已接受任务 drain、所有持久化边界崩溃、写盘失败和记录缺失。应无双驱动、无自动重发未知消息、无删锁绕过、旧数据不被改写。任何未覆盖来源继续阻断。
3. **正式分发产物验签**：分别篡改 manifest、signature、payload；错误密钥、同key不同合法包、过期/撤销、旧序号、错误host/架构/API、回退和安装中断。验收的是最终交付字节，不只是构建目录。主机时钟及本地状态回滚的限制须如实披露。
4. **另行授权的专用 QQ/NapCat 测试账号/测试群**：使用合成消息，不接入真实聊天历史；验证账号、白名单、mention、图片/文件、断网、发送中崩溃、重配与停用。不具备账号时该关保持未验收，不能以模拟数据替代。

## 人工处理与只读诊断

`read-diagnostics` 只返回五类 sidecar 的固定枚举，不返回路径、账号、token、generation、scope 或原始异常。诊断不创建目录、不修复、不删除锁，读取也不消费已有预览授权。它不是实时进程清单；正常记录同样不授权自动启动。

主程序异常退出：停止激活尝试，保留原始 sidecar，先由维护者检查已知安装/启动历史及实际进程所有权。不得将“重启电脑”或“我已关闭”的按钮直接当作启动证明。当前没有通用自动修复命令；若证据不足就保持阻断，不提供 `rm owner.lock` 一类捷径。

## 可复现的云端检查

```sh
corepack pnpm install --frozen-lockfile
node node_modules/vitest/vitest.mjs run src/main/qq-modules src/renderer/react/features/settings/QqModuleDiagnosticsPanel.test.tsx --maxWorkers=2
corepack pnpm run build
corepack pnpm run check:renderer
```

配对真实子进程/媒体检查沿用 host-integration.md。云端 Linux、合成 Windows policy/context、临时 AES 存储及 mock OneBot 都有明确用途，但均不是上述真实 Windows 或真实 QQ 验收。
