# 启动动画

默认关闭，保留原有 Loading。用户启用后，Agent 用自己的 Electron 窗口播放本地 MP4，同时初始化核心。无需单独的 EXE、.NET、外部启动器或额外构建步骤。

## 常规设置

- **关闭**（默认）：使用原 Loading，不播放视频。
- **仅启动时播放**：仅在 Agent 进程初始化时完整播放。后台已有进程时，从托盘或其他入口打开不播放。
- **除托盘外其余播放**：初始化完整播放；最小化恢复或其他入口重新打开聊天窗口时，最多显示 **1.2 秒**过渡。从托盘打开聊天或设置不播放。
- **每次播放**：初始化完整播放；其他打开方式（包括托盘）均显示最多 1.2 秒过渡。

重新打开的过渡不等待整段视频，不隐藏聊天或桌宠，不改变聊天窗口大小。过渡层不接收焦点，鼠标事件透传；聊天可立即使用。窗口已可见时切换页面或聚焦不触发播放。1.2 秒上限包含视频加载时间；加载太慢直接结束过渡。

**导入视频**使用系统文件选择器，支持 MP4（建议 H.264），最大 500 MB。文件复制到用户数据目录，移动原文件不影响播放。**恢复默认**切回随应用分发的视频，不改变播放模式。控件和行布局复用常规设置组件；错误和成功提示在视频行内部，不影响下方分隔线。中、英、日说明同步。

设置位于 `<userData>/startup-animation/settings.json`。`mode` 为 `off` / `startup` / `except-tray` / `always`；保留 `enabled` 兼容已有设置。旧版明确的 `enabled: true` 迁移到仅启动播放；没有设置时默认关闭。导入不会开启动画。

视频文件名由主进程生成 UUID，设置 IPC 不接受 renderer 指定路径。导入验证大小与 MP4 容器结构，但容器有效不保证编解码器受支持；解码失败走运行时回退。自定义视频丢失时使用默认片。旧副本保留以免删除正在播放的文件，可在退出后手动清理不再使用的 `.mp4`。

## 初始化与交接

1. `startStartupAnimation` 返回明确的 `skipped`（关闭、模式不匹配、不可用）、`already-running` 或 `starting` 状态。`starting` 不代表加载成功。
2. 专用 sandbox preload 在 `video.play()` 成功后报告播放开始，窗口才显示。加载超过 5 秒、页面加载失败、解码错误或 renderer 崩溃时，在**同一个窗口**恢复原 Loading，不另建无法被启动流程清理的窗口。
3. `core-bootstrap` 到达实际核心就绪点后，`revealStartupWindows` 等待播放结束，再显示主界面。完整播放结束且核心尚未就绪时保留末帧；播放本身超过 90 秒（包括卡顿）则回退，避免视频无限阻塞启动。
4. 主界面提前就绪不会抢先显示。正常交接时聊天窗口位置和大小同步为动画窗口，随后关闭动画。首次启动的欢迎页保留自身布局。桌宠和其他辅助窗口始终由原有生命周期管理，不被动画隐藏或调整。
5. **Esc / 跳过**立即解除视频等待；核心尚未就绪时显示 Loading，核心就绪后直接交接。关闭应用时清理播放窗口、定时器和事件监听。

初次显示采用 Electron 的普通窗口显示行为，不使用 Win32 强制前台 API、不轮询夺回焦点。重新打开时使用 `showInactive`；Esc 在动画窗口或关联聊天窗口的 `before-input-event` 中处理。用户切换到其他应用后，Esc 属于该应用，不会被全局捕获。

## 安全与打包

播放器是独立的 `BrowserWindow`：`sandbox: true`、`contextIsolation: true`、`nodeIntegration: false`。专用 preload 不暴露应用的通用 IPC、设置或文件能力；仅通过该窗口自己的 IPC 获取主进程选定的视频，并报告播放状态。主进程检查消息来自播放器主 frame，拒绝子窗口和导航。播放器 HTML 的 CSP 默认禁止资源，仅允许本地媒体和页面样式。

没有外部进程附着、窗口枚举、DWM 缩略图、`AttachThreadInput`、`ShowWindow` 隐藏或全盘扫描。旧的 C# 播放器、启动器配置、构建及原生 smoke 脚本已移除；打包仅增加默认 MP4 和 NOTICE。请直接启动 Agent；旧测试包中的独立桌面启动器不属于当前方案。

```powershell
pnpm run build
pnpm start
```

开发环境读取 `src/renderer/public/startup-animation.html`；打包后读取 Vite 复制的 `dist/renderer/startup-animation.html`。默认视频位于开发仓库 `resources/startup-animation` 或安装资源目录 `startup-animation`。

默认视频由素材提供者使用 **Seedance 2.0** 生成，**当前不含音频，后续可能加入音频**。播放器目前统一静音，包括自定义视频。素材来源、提供者声明及权利说明见 `resources/startup-animation/NOTICE.md`。

## 验证

自动化覆盖四档模式、默认关闭、原 Loading 回退、加载超时/错误、解码失败、renderer 崩溃、卡顿截止、Esc/按钮跳过、两种就绪顺序、欢迎页、退出清理、重复打开时限、父窗口隐藏/关闭，以及 IPC frame 校验和安全窗口配置。

```powershell
pnpm exec vitest run src/main/settings/startup-animation-store.test.ts src/main/startup/startup-animation.test.ts src/main/startup/animation-window-open.test.ts src/main/startup/startup-window-reveal.test.ts src/renderer/react/features/settings/StartupAnimationSettings.test.ts
```

窗口生命周期 mock 测试不能证明真实桌面焦点或安装包媒体解码正常。发布前需在交互式 Windows 桌面验证：默认 Loading、启用后完整播放、主界面快/慢加载、直接 Esc、切到其他应用后无抢焦点、四种模式的托盘与任务栏恢复、自定义视频和恢复默认，以及桌宠不受影响。
