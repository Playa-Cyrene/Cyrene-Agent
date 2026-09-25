import { defineConfig, type Plugin } from "vite";
import { readFileSync } from "node:fs";
import { resolve } from "path";
import react from "@vitejs/plugin-react";
// Streamdown 的预置布局使用 Tailwind 工具类。样式文件以 sd 前缀和局部容器隔离，
// 因此插件需要参与正式渲染构建，但不会引入全局 preflight 或产品 utility class 习惯。
import tailwindcss from "@tailwindcss/vite";

/**
 * Inject the app version (read from package.json) into any HTML that
 * contains the placeholder `<span data-app-version></span>`.
 *
 * Replaces the placeholder with `昔涟 v<version>`, matching the existing
 * display format. Keeping the prefix in the plugin (rather than the HTML)
 * means the version is the only thing that ever changes.
 */
function appVersionPlugin(): Plugin {
  const pkg = JSON.parse(
    readFileSync(resolve(import.meta.dirname, "package.json"), "utf8"),
  ) as { version: string };
  const versionText = `昔涟 v${pkg.version}`;
  return {
    name: "cyrene-app-version",
    transformIndexHtml: {
      order: "pre",
      handler(html) {
        return html.replace(
          /<span data-app-version><\/span>/g,
          `<span data-app-version>${versionText}</span>`,
        );
      },
    },
  };
}

/**
 * 生成 React 渲染页的 Content-Security-Policy。
 * - script-src 只允许 'self'，明确不含 'unsafe-eval'
 * - style-src 保留 'unsafe-inline'，兼容 Ant Design 的 CSS-in-JS 运行时样式；
 *   放行 fonts.googleapis.com（ui/fonts.css 的 Google Fonts 样式表）
 * - font-src 放行 fonts.gstatic.com（Google Fonts 字体文件本体）
 * - frame-ancestors 只在 HTTP 响应头中生效，经 <meta> 传递会被浏览器忽略，故不写入
 * - 开发环境额外放行 Vite 热更新所需的 localhost 连接源
 */
function reactRendererCsp(isDev: boolean): string {
  const connectSrc = isDev
    ? "'self' http://localhost:* ws://localhost:* https: wss:"
    : "'self' https: wss:";
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data: https://fonts.gstatic.com",
    `connect-src ${connectSrc}`,
    "media-src 'self' data: blob: https:",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
  ].join("; ");
}

/** 只对 React 渲染页注入 CSP meta 标签的 Vite 插件 */
function reactRendererCspPlugin(): Plugin {
  return {
    name: "cyrene-react-renderer-csp",
    transformIndexHtml: {
      order: "pre",
      handler(html, ctx) {
        const isReactPage = ctx.path === "/react/" || ctx.path.endsWith("/react/index.html");
        if (!isReactPage) return html;
        const content = reactRendererCsp(Boolean(ctx.server));
        return html.replace(
          '<meta charset="UTF-8" />',
          `<meta charset="UTF-8" />\n  <meta http-equiv="Content-Security-Policy" content="${content}" />`,
        );
      },
    },
  };
}

/**
 * 性能基线 harness 的专用构建开关（普通构建完全不受影响）：
 * - CYRENE_PERF_HARNESS=1：入口只保留 react-perf 页（构建快、产物独立）；
 * - CYRENE_PERF_PROFILE=1：把 react-dom/client 替换为 react-dom/profiling，
 *   生产构建下 <Profiler onRender> 才会产出数据（通道 A 专用）；
 * - CYRENE_PERF_OUT_DIR：runner 指定产物目录（相对项目根），默认 dist/renderer。
 *   注意：只 alias react-dom/client，不能动裸 "react-dom"——React 19.2 的
 *   react-dom-profiling.profiling.js 内部 require("react-dom") 获取共享
 *   internals 单例，把主入口也指向 profiling 会造成循环 require，
 *   internals 变 undefined 后页面直接崩溃（Cannot read properties of
 *   undefined (reading 'd')）。
 */
const isPerfHarnessBuild = process.env.CYRENE_PERF_HARNESS === "1";
const isPerfProfileBuild = process.env.CYRENE_PERF_PROFILE === "1";
const perfOutDir = process.env.CYRENE_PERF_OUT_DIR;

export default defineConfig({
  plugins: [react(), appVersionPlugin(), reactRendererCspPlugin(), tailwindcss()],
  root: resolve(import.meta.dirname, "src/renderer"),
  base: "./",
  ...(isPerfProfileBuild
    ? {
        resolve: {
          alias: [{ find: /^react-dom\/client$/, replacement: "react-dom/profiling" }],
        },
      }
    : {}),
  build: {
    outDir: perfOutDir ? resolve(import.meta.dirname, perfOutDir) : resolve(import.meta.dirname, "dist/renderer"),
    emptyOutDir: true,
    rolldownOptions: {
      input: isPerfHarnessBuild
        ? {
            "chat-perf": resolve(import.meta.dirname, "src/renderer/react-perf/index.html"),
          }
        : {
            renderer: resolve(import.meta.dirname, "src/renderer/index.html"),
            stickers: resolve(import.meta.dirname, "src/renderer/sticker-manager/index.html"),
            "call-react": resolve(import.meta.dirname, "src/renderer/call-react/index.html"),
            "chat-react": resolve(import.meta.dirname, "src/renderer/react/index.html"),
            music: resolve(import.meta.dirname, "src/renderer/music/index.html"),
            toast: resolve(import.meta.dirname, "src/renderer/toast/index.html"),
          },
    },
  },
  server: {
    port: 5173,
    strictPort: false,
  },
});
