# Windows 启动动画

Windows 启动时播放昔涟动画，Agent 同时加载。动画播放期间暂时隐藏同一 Agent 可执行文件的窗口；播放结束后等待主窗口连续响应 1.5 秒，将实际界面客户区同步为动画的位置、尺寸，然后显示主窗口并退出动画进程。Agent 较慢时停留在末帧；Esc / 跳过可提前交接。失败和超时退出动画层，不改变 Electron 安全配置。

## 常规设置

- **开机动画**：即时保存，下次启动生效。关闭后跳过动画。
- **导入视频**：原生文件选择器，支持 MP4（建议 H.264），最大 500 MB；复制到用户数据目录。移动原文件不影响播放。
- **恢复默认**：切回随应用分发的昔涟动画，不改变开关。

按钮、开关与其他常规设置共用控件及行布局；成功/错误提示放在视频行内部，保留下方设置行的分隔线。中、英、日文案同步。

设置路径：`<userData>/startup-animation/settings.json`，字段为 `enabled`、`videoFile`、`videoName`。视频文件名由主进程生成 UUID；IPC 不接受 renderer 指定的文件路径。导入检查大小和 MP4 容器结构，失败保留旧选择，取消不写入。不能仅凭容器检查保证 Windows 解码器支持所有 MP4 编码，因此建议 H.264；播放失败直接退出动画。

旧自定义副本保留，避免删除正在播放的文件。用户可在退出 Agent 后清理该目录中的不再使用的 `.mp4` 文件；默认视频位于应用资源目录，不会被导入覆盖。自定义文件丢失时回退默认片。关闭动画时仍可更换视频。

## 构建和运行

Windows / .NET Framework 4.x x64：

```powershell
pnpm run build:startup-animation
pnpm run build
pnpm start
```

`package:win:dir` 与 Windows 打包工作流都会构建 helper，electron-builder 将 helper、默认视频和来源说明复制到 `resources/startup-animation`。不提交 `.exe` 或本机路径。直接启动应用和登录自动启动都经过同一个 splash 创建入口。

主进程先读开关，再以 **AttachOnly** 模式启动 helper；helper 附着当前应用，不会再次启动 Electron。用户数据目录中的会话配置由主进程写入；helper 退出时清理配置，主进程退出时结束 helper 并移除生命周期监听。日志保留在 `<userData>/startup-animation/session-*/logs/launcher.log`，不记录聊天内容。

非 Windows 平台和未构建 helper 的开发环境继续使用原 splash。helper 缺失、启动异常不阻止 Agent 主窗口加载。原独立启动器可继续通过共享设置使用；它启动 Electron 时设置 `CYRENE_BOOT_ACTIVE=1`，避免两段动画。

## 测试

```powershell
pnpm exec vitest run src/main/settings/startup-animation-store.test.ts src/main/startup/startup-animation.test.ts src/renderer/react/features/settings/StartupAnimationSettings.test.ts src/renderer/react/i18n/resources.test.ts
pnpm run test:startup-animation
pnpm run test:startup-animation -- -Slow
pnpm run test:startup-animation -- -Skip
pnpm run test:startup-animation -- -Disabled
pnpm run test:startup-animation -- -Attach -Slow
# 自定义时长测试需要 PATH 中有 ffmpeg
pnpm run test:startup-animation -- -Custom
```

原生测试使用独立 WinForms 窗口，检查真实 WPF 播放、播放时隐藏、自动退出、末帧等待和 Win32 客户区坐标；不加载用户对话。测试产物在忽略的 `.build-temp/startup-animation-qa` 下。

主窗口就绪是 Win32 可见/响应/稳定性启发式，不是 Agent 内部就绪事件。隐藏是轮询完成，窗口首次显示时可能有短暂闪现；不是主进程预显示屏障。首次启动可能交接到欢迎页。安装包和真实 Agent 完整启动需在普通 Windows 桌面环境进一步验证。
