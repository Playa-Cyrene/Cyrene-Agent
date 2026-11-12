# QQ 旧数据接管与切换基础（候选）

Refs #327。基于未合并 #342（代码树 e5d59d3e），间接依赖 #339/#338；与 #341 媒体分支并列。本文描述云端隔离样例实现，不代表生产迁移已上线。

## 本次实现

- `migration-plan.ts` 从有界旧 JSON 字节构建版本 1 计划，不调用旧设置加载器的静默默认/解密失败兜底。未知 QQ 字段、异常 ID、重复白名单和非默认安全策略拒绝转换。
- `qq` 渠道 ID、现有单账号语义、QQ 白名单、群 @ 与工具限制保持不变。历史、会话、桌面对话绑定继续由宿主拥有；迁移没有复制/写入它们的 API。
- 原始 `channels-settings.json` 也不改写。计划将已解析的回环地址用于候选模块，原监听模式/文本/凭据字节原样保留。`auto` 重新解析得到 WSL 时拒绝；`localhost`、括号 IPv6、LAN/wildcard 等不受候选支持，拒绝而非替用户改成 loopback。数字 127/8、::1 和 mapped loopback 可保持。
- `previewMigration()` 生成不含 token/源摘要的预览；显示原账号、目标包、目标监听/白名单、旧凭据保护种类及回滚限制。预览对象是副本，修改它不能改变内部计划。没有确认则无文件/进程副作用。
- 确认必须指向当前预览并明确原账号。账号依据是旧适配器完成 `get_login_info`/版本握手后的账号与连接轮次，不能从配置文本/连接头推断。执行前再次核对原文件摘要、账号、连接轮次、地址解析结果和候选包验证。
- 原 token 只由宿主在内存解密，兼容 enc/obf/plain/旧明文格式。obf 使用原 userData 路径及应用名生成旧 key，不使用迁移目录。解密异常、空解密结果、畸形编码、无可靠 OS 安全存储全部失败关闭，不偷偷变成无 token。Linux basic_text/unknown 不视为安全存储。无 token 的既有 numeric-loopback 配置可以无 token 迁移。
- 不把 obf/明文包装成“安全加密”。本次不重写旧凭据，不在新 sidecar 持久化任何 token，也不假定可跨机器复制 enc 密文。JS 字符串不能保证内存物理清零。

## 停收、排空、切换

`NapCatAdapter.prepareMigrationStop()` 是专用迁移入口，当前没有生产调用点：

1. 同步停收新入站与独立发送；完整追踪已接受 handler 与 send Promise。
2. 只允许原 handler 在原连接轮次中完成发送；AsyncLocalStorage 防止旧轮次任务跨普通重启/重连发给新连接，媒体操作同样取限定 client。
3. 排空后检查账号/连接未变化，并等待真实 HTTP listener `close`。现有 server.stop() 的超时 resolve 不当成已关闭证明；无法验证则拒绝切换。
4. 超时/错误/身份变化返回 `safeToSwitch: false`，同一次尝试结果不升级。失败停收后不自动恢复接收或重启旧实例。

协调器写入 prepared 意图后才停旧驱动，依次记录 legacy-stopped / module-staged / committed。仅旧驱动明确已排空且已停止才允许创建候选进程。候选运行时先通过兼容 hello，再交接 token；`stageForMigration` 全程隔离新收发，并有界等待 backend 异步重连和已验证原账号，默认 30 秒（测试可注入）。只有落盘 committed 且当前仍为正确 running 账号才能激活。

模块阶段失联、错账号、验证/写入失败会先停止候选；退出不确定就保留 recovery-required，不启旧驱动、不启动另一个模块、不重试未知发送。新旧消息的恰好一次交付不在保证范围内；不重放旧队列。

## 持久化与恢复边界

`QqMigrationStore` 使用专用目录、独占锁、有界/严格 schema、symlink/hardlink 拒绝、临时文件 fsync + 同卷 rename。只存版本化迁移元数据、原文件摘要、公开配置及账号 pin，不备份/导出 token，不覆盖旧用户文件。锁冲突/异常 schema/未完成意图一律阻止新迁移。重复成功/失败确认幂等。

**这是原文件不变的接管方案，不是整份用户数据备份，也不声称断电级跨平台持久性。** 本次没有 userData 批量复制/恢复；原数据仍在原处。文件 fsync + rename 未包含目录 fsync，也未证明 Windows 断电语义。相同 OS 用户恶意进程不在目录检查可防御范围内。

重启看到任何未明确回滚记录时只报告需要检查，不自动启动任一驱动。`rollbackStoppedMigration()` 只在宿主提供当前全部驱动已停止的可信证明后，将本地选择标记回 legacy；如果本次进程持有候选 manager，还先验证其退出。旧程序/旧后端是否仍存在、能否启动、账号是否仍一致，是另一个独立事实，不由“原数据未变/已回滚”推导。本次从不自动重启旧实现。

崩溃可能遗留独占锁，当前失败关闭且不提供自动删锁。安全清理/进程归属确认尚待后续生产编排。调用方不能用 `true` 常量代替真实全部进程停止证明。

## 仍然关闭或尚待验收

- 主程序 `init.ts` 继续注册原 NapCatAdapter，设置页没有迁移执行 IPC；没有生产下载、安装、选择或自动恢复入口。
- 可信 QFCA 正式发行包、公钥信任/撤销、支持矩阵、生产 manager 构造和进程归属恢复尚待实现/确认。`verifyCandidate` 由受信宿主供应，测试仅使用假候选；不能把 renderer 参数接到 executable/公钥。
- 此分支不包含 #341 媒体增量；候选模块媒体仍关闭。旧 token 保护升级/安全存储 unavailable 时的用户交互与重新授权仍待生产 UI。无安全存储时保持旧数据原样并停止迁移，不安装 keychain 或生成新 token。
- 真实 Electron/Windows、真实 QQ 收发、安装包内容及断电恢复尚未验收。原内建实现不删除，官方 QQ 不切换，默认安装包去除迁出实现不是本增量完成的事项。
- 避免将本候选 merge/deploy 或自动切换真实数据；#327 仍保持开放。

## 可复现验证

Node 24.x、pnpm 10.33.0，安装仓库既有依赖后：

```sh
pnpm exec vitest run src/main/qq-modules src/main/channels/adapters/qq
pnpm exec vitest run src/main/channels src/main/qq-modules src/plugins src/shared src/renderer/react/features/settings/QqModuleInstallationCard.test.tsx
pnpm run check:main
pnpm run check:preload
pnpm run check:renderer
pnpm run build
pnpm test
```

迁移端到端样例使用临时目录原路径旧配置、真实 LogEntry 日志、BindingStore version 1 绑定与 ConversationDatabase 创建的 SQLite transcript（含 WAL）、真实 localhost fake OneBot WS 和 FakeTransport 模块，不使用用户电脑或真实 QQ。覆盖先排空关闭后启动、错误/延迟账号、隔离收发、重复确认、三阶段写入故障、重启元数据、退出未知、过期锁、配置变化、解密失败与原文件字节一致。全仓已知平台基线失败应分别报告，不把定向通过描述为全仓全绿。
