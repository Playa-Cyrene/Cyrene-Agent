# QQ 独立模块媒体候选

## 依赖和不变项

Refs #327。本增量基于尚未合并的 [主仓 Draft #339](https://github.com/Playa-Cyrene/Cyrene-Agent/pull/339)（`57216fa98c538b95d8964c0ad1842b7c23a0ea95`），后者依赖 #338。配套模块以 [QFCA PR #1](https://github.com/LZhWi/QFCA/pull/1)（`97bd748de67ed3280bbeaac6f530ad3ac138a6c7`）为基础；两个新媒体候选必须配套审查。

- 不复用普通插件 SDK/加载器或其权限模型，不新增通用 action/file API。
- 不改 `initializeChannels`，现有内建 QQ 仍在，官方 QQ、其他渠道与桌面聊天不切换。
- 固定 `qq` 身份、宿主账号确认、白名单、群 @、工具权限、绑定、dispatcher、队列与 journal 的职责保持。媒体句柄不进入会话历史；交给 dispatcher 的仍是宿主缓存路径。
- 不发布模块、不合并、不安装或连接真实 QQ，也不宣称完成 #327。

## 协议与数据流

可信宿主显式注入 `QqMediaBroker` 时在 initialize 加 `mediaTransfer: "chunked-v1"`；省略则 QFCA 保持文本模式。旧基础 QFCA 不认识这个字段，因此带媒体的新宿主不应配旧模块启用，初始化会拒绝；不注入 broker 时保留原文本初始化。

出站：宿主验证明确的 `OutgoingMessage.filePath` 是同一个普通文件，读取受配额约束的不可变快照并计算 SHA256。通过 begin 获得随机句柄，分块写入模块临时 spool，最后一个块校验实际大小和散列。send 仅传句柄及元数据。模块再核对 operationId、conversation、connectionEpoch、kind/size，上传到已验证后端并发送。后端返回的路径只留模块内部，宿主路径从不交给模块。

入站：模块仅使用当前已授权事件中的 opaque file/file_id，拒绝路径、URL、scheme；媒体字节经后端 stream 落临时 spool。宿主按当前 eventId/connectionEpoch 分块读取，落自己控制的缓存目录，确认完整后将 `ChannelAttachment` 交原 dispatcher。媒体失败保留文本和安全占位；权限、连接或生命周期撤销后不调用 handler，丢弃未交付缓存。

传输上限：64 KiB/块、100 MiB/文件、512 MiB/缓存预算、模块句柄 5 分钟，传输操作 120 秒。宿主出站快照可占单文件大小内存，计入总预算；不是零拷贝。已交 dispatcher 的宿主缓存按 24 小时在后续传输/显式 cleanup 时惰性清理，不因模块 stop 就删除。实现细节见 [宿主媒体边界](../../src/main/qq-modules/MEDIA.md)。

## 后端能力

只对确认为 `NapCat.Onebot` 的后端尝试专属媒体扩展，不比较其他后端版本号。真实执行 `can_send_image/can_send_record`、十包 `test_download_stream` 和一个固定、无用户数据的小型临时上传，验证 wire 与 SHA256 后才开放 image/audio/file/video。探测不发送 QQ 消息；探针文件使用 5 分钟后端保留期。探测失败保留文本模式，断开或旧探测完成不能把能力带到新连接。

使用官方源码核实的 image/record/file stream 接口。语音 MP3 转码的 file_info 可能携带转码前大小，所以只对该明确转换场景按 100 MiB 上限预留，完成后以受限累计字节和 terminal 验证实际大小并缩减配额。其他媒体保持声明/累计大小严格一致。

主要依据：NapCat 官方 [文件处理说明](https://doc.napneko.icu/develop/file) 与源码提交 [`72912f293924f43463b5976b01fc094a8ae11481`](https://github.com/NapNeko/NapCatQQ/tree/72912f293924f43463b5976b01fc094a8ae11481/packages/napcat-onebot/action/stream)。源码检查不是实际 QQ 收发验收。

## 验证入口

先在 QFCA 媒体候选执行 `npm run verify`，再在主仓：

```sh
QFCA_ENTRY=/absolute/reviewed/qfca/dist/runtime/entry.js pnpm exec vitest run src/main/qq-modules src/shared/qq-module
QFCA_ENTRY=/absolute/reviewed/qfca/dist/runtime/entry.js QFCA_LARGE_MEDIA_TEST=1 pnpm exec vitest run src/main/qq-modules/qfca-media-compatibility.test.ts
pnpm run check:main && pnpm run check:preload && pnpm run check:renderer
pnpm run build
pnpm test
```

集成测试只 fork 明确指定的已审查本地 build，不下载/执行任何 Release。fake OneBot 在 loopback 与隔离临时目录运行，覆盖四类媒体双向流、100 MiB 实际字节散列、文本/路由、无 broker、能力缺失、损坏流和路径拒绝。没有 QFCA_ENTRY 的默认主仓测试会明确跳过跨仓测试；大文件项另需显式 opt-in。

## 未完成及限制

- URL 直取、card、sticker 发送未开放；不是原 adapter 的全部媒体能力等价替代。
- 安装器、发行 manifest、签名/来源验证、升级/迁移/回滚、设置 UI、主仓移除旧 QQ 实现另行实现。
- 独立 Node 进程不是 OS 沙箱；IPC structured clone 仍在收到对象之后限额，不能承诺解码前巨帧防护。
- 真实 QQ/NapCat、Electron utilityProcess、Windows 安装包与真实 Windows 文件权限未验收。Linux fake 测试不能替代这些检查。
- 发送不保证恰好一次。保留 sent/partial/failed/unknown；旧 adapter 的 ok 映射不变，不自动重试 unknown 或部分发送。
