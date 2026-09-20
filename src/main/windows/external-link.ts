import { app, shell } from "electron";
import { isDev } from "../env";

/**
 * 处理外部 URL：非 http(s) 拒绝，开发环境 localhost:5173 也拒绝（避免调试时误开）。
 * 返回 true 表示已拦截并转交给系统浏览器。
 */
export function openExternalUrl(url: string): boolean {
  if (!url.startsWith("http://") && !url.startsWith("https://")) return false;
  if (isDev && url.startsWith("http://localhost:5173")) return false;
  void shell.openExternal(url);
  return true;
}

/**
 * 全局导航兜底：任何窗口（含未来新增）的页面内导航一律阻止，
 * http(s) 外链转交系统浏览器。覆盖把文件拖到非投放区导致窗口
 * 跳转 file://、页面意外跳转等场景。
 * 应用入口模块顶层调用一次即可，替代逐窗口挂载，避免新窗口漏挂。
 * 安全边界：
 *  - loadURL/loadFile 等程序化加载不触发 will-navigate，正常加载不受影响；
 *  - will-navigate 只针对主 frame，插件面板的 sandbox iframe（cyrene-plugin://）不受影响。
 */
export function installGlobalNavigationGuard(): void {
  app.on("web-contents-created", (_event, contents) => {
    // 应用页面不派生新窗口：http(s) 外链转系统浏览器，其余（含 file://）一律拒绝
    contents.setWindowOpenHandler(({ url }) => {
      openExternalUrl(url);
      return { action: "deny" };
    });

    // 页面内导航一律阻止，http(s) 再转交系统浏览器
    contents.on("will-navigate", (event, url) => {
      event.preventDefault();
      openExternalUrl(url);
    });
  });
}
