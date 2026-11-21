# 真实 Electron 旧 listener → QFCA 升级隔离验收

`upgrade-integration-electron.cjs` 只运行独立 Electron 入口，不加载 Cyrene 主应用，不访问真实用户 profile、QQ 账号或消息。使用脚本新建的临时 userData，退出前验证停止并删除任务数据。**不启用生产、不提供正式签名人/密钥、不批准任何旧版本。**

## 真实与模拟边界

真实链包括磁盘 settings loader、NapCatAdapter、QqRoutingAdapter、旧 HTTP/WebSocket listener、挂起的已接收 turn、production-host 与 gateway 明确确认迁移、持久化 stores、签名候选校验、完整 QFCA 依赖闭包以及 Electron utilityProcess。监听 close 与每个 child exit 都观察实际事件，不用 PID/端口扫描替代。

模拟部分是合成 OneBot 客户端、人工 `plain:synthetic` 旧凭据（不声称旧 enc/obf 解密验收）、新凭据 AES 测试存储（不等 Windows DPAPI）、一次性 Ed25519 测试签名和演练时钟。adoption 的 win32 context 仅模拟接口，历史证明只覆盖脚本独占的临时 scope。**实际测试 OS 为 Linux/x64；旧实现是在同一测试 host 内的当前 legacy adapter，不是已安装的旧版 Windows 二进制。**

## 命令

先构建 host main，按 `host-integration.md` 准备适用于当前 OS/架构的离线演练候选。以下每个场景均应单独启动 Electron：

```sh
QFCA_UNSIGNED_CANDIDATE=/absolute/reviewed/unsigned.json \
QQ_UPGRADE_SCENARIO=success \
node_modules/electron/dist/electron --headless --ozone-platform=headless \
  scripts/verify/qq-module/upgrade-integration-electron.cjs
```

支持的场景：

- `success`：旧 turn 挂起时拒新入站及取消确认；观察真实 server 收到被拒帧；释放 turn 后先监听 close、再 fork；同端口重连核验身份；新路由双向消息；真实 child 退出、显式恢复、clean-retired 跨 host 恢复，无自动启动。
- `wrong-account`：新真实 child 接到错误身份后不能激活/出站，实际退出，旧 listener 不恢复。
- `lost-proof`：新 child 身份探测挂起时撤销模拟历史 scope，放行后回滚、实际 child exit，保留 dirty lock，不能宣称 clean retirement。
- `shutdown-drain`：真实旧 turn 挂起时请求 shutdown，等待在途事务，关闭 listener，不允许晚 fork。取消后的 adoption 证据仍不可信；允许 shutdown 返回 ADOPTION_LOST，而非假称 clean retirement。
- `shutdown-stage`：真实 child 身份探测挂起时 shutdown，已接受事务收尾后才完成实际 child exit，不允许 shutdown 完成后再 fork。

成功标识为 `ALL_REAL_UPGRADE_ELECTRON_PASS scenario=...`，退出码 0。任何非预期清理失败都会输出 `CLEANUP_INCOMPLETE` 并失败，不能把资源未停当作验收通过。

## 首轮结果及断言修正

在 host 源码 `806ec9c` 对应构建上，五场景最终均退出 0。成功顺序为：

```
legacy-turn-finished → legacy-listener-close → child-1-created → child-1-exit
→ child-2-created → child-2-exit → child-3-created → child-3-exit
```

早期 harness 有两项断言过窄，未据此认定产品缺陷：

1. 错账号/证明丢失后要求 `getDriver()==blocked`，实际 router 保留已停止 manager，因此内部标签仍为 module。改为验证 legacy 被阻断、manager stopped、无 active identity、send 拒绝、start 拒绝、实际 child exit 及不自动重启。
2. shutdown 期间要求新请求固定返回 recovery-required，实际 gateway 对在途确认先返回 busy。改为接受这两层正确的拒绝结果，继续验证实际停止顺序。

仍待现场验收：Windows DPAPI/ACL、真实安装器历史证明、明确旧版 artifact 升级资格、真实 QQ/NapCat 行为，以及真正旧二进制到新安装包的升级。不能以本脚本测试替代这些条件。
