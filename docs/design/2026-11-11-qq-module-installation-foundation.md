# QQ 可选模块：安装入口与离线安全基础

关联 [RFC #327](https://github.com/Playa-Cyrene/Cyrene-Agent/issues/327)，基于 Draft [#338](https://github.com/Playa-Cyrene/Cyrene-Agent/pull/338) / [#339](https://github.com/Playa-Cyrene/Cyrene-Agent/pull/339) 的 `57216fa98c538b95d8964c0ad1842b7c23a0ea95`。不依赖媒体增量。

## 当前边界

2026-11-11 检查 QFCA Releases 返回空列表，未确认正式模块包、发布格式、签名公钥、密钥管理者或真实支持矩阵。因此本次**不开放下载安装、激活或迁移**。没有伪造生产密钥、默认受信 URL、签名或安装成功状态。源码中的测试密钥临时生成，只签惰性测试文本，不是发行信任根。

原 QQ 设置位置新增“查看模块安装条件”入口。只有点击才调用只读状态 IPC；下载/安装按钮始终禁用。关闭、重复点击、重开、状态失败和迟到响应有测试。不存在接收 URL、任意文件路径、公钥或安装开关的 renderer IPC。普通插件机制不参与。

现有内建 QQ adapter、官方 QQ、配置、token、历史与绑定保留。此增量不代表 #327 的“默认安装包不含迁出 QQ 实现”已经完成。安装安全代码可以在本体中，但 QFCA payload 不能被主程序默认打包；本次没有增加任何 payload、依赖或下载规则。移除旧实现和逐包检查留待可用发行物、迁移与 Windows 验收完成后。

## 首版监听兼容性

QFCA #1 的安全修复将首版限定为**数字 IP 的本机回环监听**。宿主候选 runtime 在创建进程、交接凭据前使用同一判定，原内建 adapter 的监听规则不改变。

- `node:net.isIP` + `BlockList` 的 `127.0.0.0/8` 和 `::1`，包括被该 API 正确映射的 IPv4-mapped loopback。
- 不接受 DNS（含 localhost）、方括号 IPv6、scope ID、整数/缩写/octal IPv4、wildcard、LAN、WSL、public、link-local 和 mapped 非回环。
- 安装条件预检先由主进程解析 auto/WSL/custom；解析为非支持地址就显示不兼容。Token 不会开启远程支持；不静默改写/降级配置。
- 后端若通过受信加密隧道在本机回环终止，仍须另外明确配置。本增量不创建隧道或宣称支持任意远程部署。

## 候选包校验（仅离线基础）

`package-verifier.ts` 接受原始 manifest 字节、分离的 Ed25519 签名，以及宿主提供的文件字节 Map。它不是压缩包格式、网络下载器、npm 安装器或可执行包入口。

- 严格、限长 JSON manifest；UTF-8 字节须与 `JSON.stringify(JSON.parse(bytes))` 相同，拒绝重复键、未知字段及非规范数值。签名覆盖域分隔符 `Cyrene/QFCA/package-manifest/v1\0` 与完整原始 manifest 字节。
- keyId 必须查到宿主持有的 Ed25519 SPKI PEM 公钥。包不携带可自行提升信任的公钥；hash 仅证明与已认证清单一致，不代表发布者可信。
- 签名包含 qfca 身份、模块版本、单调 releaseSequence、Unix 毫秒签发/过期时间、hostVersionRange、API 支持区间、平台/架构、入口和全部文件的大小/SHA-256。
- 版本范围候选暂限发布三段版本与 `[minInclusive, maxExclusive)`。不假称支持完整 npm semver、prerelease 或已实测版本矩阵。
- 清单限 256 KiB、2048 文件、单文件 32 MiB、总量 64 MiB。拒绝缺/多文件、大小/hash 错误、大小写重复、路径穿越、绝对/驱动器/UNC/ADS、Windows 设备名及文件/目录别名。
- 文件是字节而不是归档条目：不接受软链接、硬链接、解压器、postinstall 或脚本执行。未来真实格式必须先通过独立审查，不能把解压步骤直接接到该原语上。

## 候选安装事务（未接入生产）

`QqPackageStore` 使用宿主选定的专用绝对目录，尚未由启动流程创建。构造和状态读取不创建目录；安装/回滚需 `userConfirmed: true`。这个类型参数只表达内部调用前置条件，不能证明一次真实人机确认；生产 UI 的具体版本、来源、权限和切换预览尚待实现。

1. 写入前完整验签、兼容性及文件校验，快照字节。
2. 专用标记目录与独占锁；未知已有目录、symlink 父路径、非普通文件/硬链接被拒绝。不覆盖任意已有文件。
3. 新随机 staging 中以 `wx` 写入并 fsync；发布为 manifest digest 命名的不可变代码目录后再次读取校验。
4. 同卷临时 state 文件写入后 rename 原子替换选择指针，作为提交点。不先删除旧指针。
5. 提交前失败只清理本次新建目录，旧包和旧选择不动。旧包到期、撤钥、损坏或宿主不兼容不阻止安装一个合法修复包；选用/回滚旧包仍须按当前信任、时间和兼容性重新验证。
6. 显式回滚选择上一个仍受信且兼容的版本，不降低 releaseSequence 高水位。旧包保留，聊天/配置/历史/绑定所在目录完全不参与事务。

没有自动执行新包、自检启动、新旧 driver 切换、旧账号确认、卸载或用户数据迁移。`getSelected` 返回校验后的候选信息，不启动模块；实际运行时仍必须在激活前重新验证并取得路径，排空旧 driver 后切换。

## 上线前的阻塞项

- 确认真实发布者和离线固定公钥、私钥保管/轮换/撤销流程、受信发布端点和签名元数据分发方式。GitHub 仓库 URL/Release 名称不等于信任根。
- 确认真实打包格式、许可/依赖闭包、平台/Node/Electron/host/API/模块兼容矩阵；验证签名构建和可复现样例。当前 QFCA 源码版本不等于受信可安装发行版。
- 下载器需限制来源/重定向、限长、超时、取消、重试及完整性，不把 renderer 提供的 URL/密钥作为信任配置。网络测试与真下载均未执行。
- 进程崩溃可能遗留 stage、未提交版本或锁。当前保留最后可验证指针、拒绝后续写入并要求恢复，不自动判断/删除活跃锁。**尚未实现安全重启恢复或孤儿包清理**，不能称中断恢复已完成。
- fsync 文件 + 同卷 rename 不是跨平台断电持久性保证。目录 fsync、Windows 文件占用/权限/磁盘满/断电行为，以及最终安装包需实际验证；当前只在云端 Linux 测试。
- 选择指针回滚不等于已实现运行时/账号/配置迁移事务；必须补备份预览、停机排空、账号 pin、新包握手与失败恢复后才开放激活。
- 同 OS 用户恶意代码能竞态替换文件/密钥/进程；独立 Node 进程与目录检查不是安全沙箱。本原语不声称抵御拥有相同用户权限的任意代码。

## 可复现验证

Node 24、pnpm 10.33.0，使用现有锁文件依赖：

```sh
pnpm exec vitest run src/main/qq-modules src/main/channels src/plugins src/shared src/renderer/react/features/settings/QqModuleInstallationCard.test.tsx src/renderer/react/features/settings/ChannelsSettingsMigration.test.ts src/renderer/react/i18n/resources.test.ts
pnpm run check:main
pnpm run check:preload
pnpm run check:renderer
pnpm run build
```

测试覆盖临时签名包校验、三处故障回滚、重复/并发安装、过期/撤钥/不兼容旧包的合法修复、重启读状态、防重放、回滚重新校验、残留锁失败关闭、symlink/额外文件拒绝，以及旧用户文件不变。监听预检与候选 manager 覆盖有 token 仍拒绝远程，UI 覆盖关闭/重开/重复点击/迟到响应。QFCA 实际进程联调仅在显式配置 `QFCA_ENTRY` 时运行，不将默认跳过项说成通过。

### 本轮验证结果

- 最终定向回归：76 文件、891 项通过；1 个实际 QFCA 进程联调用例因未设置 `QFCA_ENTRY` 跳过。
- `check:main`、`check:preload`、`check:renderer` 与完整 `build` 通过；现有大 chunk 提示和 jsdom 的 getComputedStyle 提示保留。
- 全仓：615 文件通过、5 文件失败、7 跳过；7041 项通过、8 失败、36 跳过。失败是 7 项截图 Windows 路径假设与 1 项后台 shell PID，均位于未改动文件，与 #338/#339 已记录同机基线一致，不把全仓描述为全绿。
- 一次与全仓/构建并行的定向运行出现已有子进程测试等待入站超时；待并行任务结束后最终 891 项回归通过，未为此放宽生产超时或修改测试。
- 独立审查提出的旧包到期/撤钥阻断修复更新、UI 失败保留旧监听状态已修正并补回归；`git diff --cached --check` 通过。
- 没有运行真实 QFCA 下载/安装、Electron GUI、Windows 安装包、账号迁移或 QQ 实际收发。所有安装测试只使用临时目录与惰性假包。
