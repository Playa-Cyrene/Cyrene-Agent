# QQ 宿主媒体桥接候选

该候选没有注册到 `initializeChannels`，不替换现有 NapCat。只有可信宿主显式构造 `QqMediaBroker(cacheDir)` 并注入 `QqModuleManager` 时才开放 image/audio/file/video；card/sticker 明确关闭。没有自动安装、下载模块或真实 QQ 连接。

## 边界

- `cacheDir` 必须是宿主控制的私有目录，不得来自 renderer 或模块。逐段 lstat 拒绝符号链接目录及 junction，再校验目录身份并使用 realpath 规范路径，允许 Windows 合法盘符/路径大小写规范化。入站文件使用随机名；非图片附件的原始文件名只提供白名单扩展；模块路径和 URL 从不传入文件系统 API。
- 入站 `image` 先有界读取最多 64 字节，按实际文件头识别 PNG/JPEG/GIF/WebP/BMP，再用固定后缀和 MIME 写入随机 `wx` 文件。缺省文件名、`fixture.bin` 或误导后缀/MIME 不影响格式；SVG/HTML/可执行文件及无法识别的头部拒绝进入图片链路。短块头部可跨多次读取，不按声明大小分配图片内存，也不增加 rename/覆盖窗口；只有成功打开的缓存路径参与失败清理。
- 出站只读取宿主 `OutgoingMessage.filePath`。拒绝 URL-only、目录、最终符号链接、空文件及超限文件。打开前 lstat 拒绝符号链接，打开后以 bigint dev/ino 核对 fd 与前后路径身份（不依赖 Windows 的 O_NOFOLLOW 支持）。一个打开的 fd 读取有界不可变字节快照，核对 stat 后计算 SHA256，再以 64 KiB base64 块上传。普通文件名清洗后传输，绝不发送宿主路径。
- 单文件最多 100 MiB，也受模块当前 `maxFileBytes` 限制；缓存与读取中的内存快照合计预算 512 MiB。出站快照会在上传结束释放内存。已交 dispatcher 的入站文件保留至 24 小时，在后续传输或显式 `cleanup()` 时回收；重启会重新统计缓存。
- 每次传输总限时 120 秒，RPC 接受 AbortSignal。停止、换连接、更新策略立即取消准备中的媒体，异步边界后再次核对实例、连接、策略、有效回合及能力。既有文本回合仍按原来的 bounded draining 规则收尾。
- 入站句柄只用于当前 event 的 `mediaRead`，不会进入 history。dispatcher 仅收到宿主缓存 `ChannelAttachment.filePath`。普通附件读取失败保留文本并增加安全占位；取消授权不会调用 handler，已准备的缓存也会删除。
- 带媒体事件在下载完成后 ack，文本事件保持立即 ack；发送完成/失败释放上传句柄，下载结束/失败释放入站句柄。未收到 begin 回复时无法得知句柄，由模块超时或连接撤销清理。已发送请求的 unknown/partial 结果不自动重试。
- 出站逐 part 准备；缺失/超限/准备失败或不支持的附件只标记该原始 part 失败，其他文本和媒体仍可发送。模块只收到成功准备的子集，返回索引映射回原输入并汇总 sent/partial/failed/unknown；本地失败不会变成 unknown。策略、连接、停止或回合撤销仍拒绝整条消息，不得降级后继续发送。
- 只接受严格 base64、正确偏移/长度/EOF；文件内容本身仍是不可信数据，交由现有文件处理管线处理，媒体桥不执行文件。
- 图片识别只是有界 magic/基本容器头检查，不是完整解码、所有截断内容校验或恶意内容扫描，也不保证视觉模型接受该图片。图片消费者原有 20 MiB 限制保持。测试验证下载后的真实 `buildAgentRunOptions` 生成正确 MIME/base64 的 `image_url`，不调用外部模型。

## 离线验证

只使用 fake transport 与隔离 tmp 文件，不需要 QQ 或用户电脑：

```
node node_modules/vitest/vitest.mjs run src/main/qq-modules/manager.test.ts src/main/qq-modules/manager-media.test.ts src/main/qq-modules/media-broker.test.ts src/main/qq-modules/media-image.test.ts src/main/qq-modules/media-image-failure.test.ts
node node_modules/typescript/bin/tsc -p tsconfig.main.json --noEmit
```

真实隔离子进程验证（先构建已审查的 QFCA，仍仅使用临时假后端）：

```
QFCA_ENTRY=/absolute/reviewed/QFCA/dist/runtime/entry.js QFCA_LARGE_MEDIA_TEST=1 pnpm test src/main/qq-modules/qfca-compatibility.test.ts src/main/qq-modules/qfca-media-compatibility.test.ts
```
