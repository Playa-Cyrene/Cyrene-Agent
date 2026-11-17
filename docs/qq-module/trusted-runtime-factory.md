# 受信安装候选到 Electron 运行实例

## 组合入口

`QqPackageStore.resolveSelectedRuntime(expectedPackageId)` 只接收可信主机此前确认的包 ID，不接收路径。它要求该 ID 正好是当前 active 选择，且没有安装/恢复锁；重新读取完整清单和文件、校验签名、信任根、有效期、平台/架构、主机/API版本及文件完整性，然后从 store 自己的根目录和已验证清单构造：

- `packageDirectory`：该包的 `payload` 根。
- `entryPath`：`payload` 根下清单声明的入口，包括合法的嵌套相对路径。

验证后再次检查选择和锁。返回对象是 **host-only**，不可序列化给 renderer，也不是持久化执行许可。

`createQqTrustedRuntimeFactory({ packages, mediaCacheDirectory?, onMessage?, timeouts? })` 返回迁移 coordinator 所需的 `verifyCandidate` 和 `createModule` 两个端口。应与 installation controller 共用同一个 package store，例如在可信主机组合代码中：

```ts
const runtime = createQqTrustedRuntimeFactory({
  packages,
  mediaCacheDirectory: hostOwnedCacheDirectory,
  onMessage: trustedDispatcher,
});
const migration = new QqMigrationCoordinator({
  ...hostOwnedMigrationOptions,
  ...runtime,
});
const controller = new QqInstallationController({
  packages,
  verificationContext: currentHostTrustContext,
  migration,
});
```

此片段是未来 host composition 契约，**不是要求在当前生产启动中执行**。发行信任、唯一驱动选择及恢复门控未完成时，生产继续构造默认禁用状态，不注册可写 IPC，不从环境变量、renderer 或包自身接受信任根。

## 执行与凭证边界

- 创建工厂或 manager 不读取 store、不写缓存、不启动进程。配置和凭证进行内存快照，调用者事后的对象修改不改变已确认账号。
- 每次真实启动（包括 manager.restart）都重新解析并验证固定 package ID，再调用实际 `createQqUtilityProcess`。安装替换、撤销信任、包过期或内容篡改会阻止新进程启动。
- 媒体缓存路径仅由可信主机提供，必须绝对且不是磁盘根；缺省不提供 broker，媒体能力关闭。实际缓存文件只由 broker 在需要时按其现有安全策略创建。
- 凭证经 manager 私有初始化 IPC 发送给已选中进程，不放在 fork 参数、工作目录或环境中。此工厂不保存凭证到磁盘。
- 返回的 manager 仍由 coordinator 隔离启动、验证身份及显式激活。工厂本身不宣称驱动已切换。

## 非沙箱和并发限制

完整验证及路径包含检查 **不是 OS 沙箱**。调用 resolver 不会持有贯穿执行期的文件锁，也不建立跨进程启动租约。主机必须串行协调安装、回退、唯一驱动停止/启动；验证后检查选择只是缩小失效窗口。

拥有同一 OS 用户权限的恶意进程仍能在最后校验后替换目录/文件，或修改正在运行模块依赖（TOCTOU）。本实现没有声称防御这一威胁。若将来要求该边界，需要独立权限/不可变发布目录等额外机制，不能靠 realpath 和重复 hash 宣称完成。

## 验证

```sh
pnpm exec vitest run src/main/qq-modules/trusted-runtime-factory.test.ts \
  src/main/qq-modules/package-installation.test.ts \
  src/main/qq-modules/utility-process.test.ts
pnpm run check:main
```

测试使用真正 package store、resolver、factory、utilityProcess 适配器和 manager，仅 mock Electron 最底层 `utilityProcess.fork`，并以合成 IPC peer 应答。覆盖嵌套入口、精确选择、trust/时效/兼容/篡改/锁、无构造副作用、凭证快照和每次 restart 重验。它不等价于真实 Electron 二进制或真实 NapCat 联调，这两项仍需独立验收。
