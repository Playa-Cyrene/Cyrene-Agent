/**
 * Electron 主进程入口 —— 应用组合根（Composition Root）。
 *
 * 此文件只表达应用生命周期：创建 Application、绑定 Electron 生命周期、
 * 在 ready 前完成同步预配置，并在主进程就绪后按
 * shell → core → background 阶段启动。全部业务子系统的装配位于
 * application/default-dependencies.ts；启动编排位于 application/application.ts。
 */

import { app } from "electron";
import { createApplication } from "./application/application";
import { createDefaultApplicationDependencies } from "./application/default-dependencies";
import { registerPluginPanelScheme } from "./plugin-panel-protocol";
import { installGlobalNavigationGuard } from "./windows/external-link";

// 打包版双击启动时 stdout/stderr 管道可能不存在或中途关闭，
// 此时任何 console.log 写入都会抛异步 EPIPE 并升级成 uncaughtException 弹错误框
// （如 mcp-adapter connectMcpServer 的连接日志）。在入口最顶部挂 error 监听器
// 静默兜底：日志丢弃无害，业务不受影响。
for (const stream of [process.stdout, process.stderr]) {
  stream?.on?.("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EPIPE") return;
    throw err;
  });
}

// 插件设置面板协议：scheme 特权必须在 app.ready 之前注册（Electron 硬性要求）
registerPluginPanelScheme();

// 全局导航兜底：阻止任何窗口的页面内导航（含拖放文件跳转 file://），
// http(s) 外链转交系统浏览器。必须在任何窗口创建之前注册。
installGlobalNavigationGuard();

const application = createApplication(createDefaultApplicationDependencies());

application.installLifecycleHandlers();
application.prepareBeforeReady();

if (application.isPrimaryProcess()) {
  void app.whenReady()
    .then(() => application.start())
    .catch((error) => application.handleFatalStartup(error));
}
