// 内置高危工具 — 给 agent 装上 fetch_url / run_shell / install_mcp_server 三件武器
// 全部走权限网关：fetch_url=network, run_shell=shell, install_mcp_server=fs-write
//
// 工具实现已按工具拆分到 builtin-tools/ 子目录（纯搬移，逻辑未改）。本文件保留为
// facade / composition root：re-export 公共 API，并按原 built-in-tools.ts 的注册顺序
// 显式 toolRegistry.register 各工具常量——顺序 = registry 插入顺序 = 工具目录 prompt
// 生成顺序，由源码顺序显式保证，不依赖 import 求值顺序。
// 门禁：built-in-tools.snapshot.test.ts（注册顺序 + 模型可见字段 + 拒绝路径协议）。

export { setUserTimezoneConfig, currentUserTimezone } from "./builtin-tools/timezone";
export { setWeatherConfig, type WeatherCardData } from "./builtin-tools/weather-tool";
export { setSearchConfig } from "./builtin-tools/web-search-tool";

import { toolRegistry } from "./registry/tool-registry";
import { logger, LogTag } from "../../logger";
import { createPlayLive2DActionTool } from "./builtin-tools/play-live2d-action";
import { weatherTool } from "./builtin-tools/weather-tool";
import { webSearchTool } from "./builtin-tools/web-search-tool";
import { fetchUrlTool } from "./builtin-tools/fetch-url-tool";
import { downloadFileTool } from "./builtin-tools/download-file-tool";
import { readImageUrlTool } from "./builtin-tools/read-image-url-tool";
import { installMcpServerTool } from "./builtin-tools/install-mcp-tool";
import { runVerificationTool } from "./builtin-tools/run-verification-tool";
import { runShellTool } from "./builtin-tools/run-shell-tool";
import { shellJobTool } from "./builtin-tools/shell-job-tool";
import { findFilesTool } from "./builtin-tools/find-files-tool";
import { openFileTool } from "./builtin-tools/open-file-tool";
import { sendFileTool } from "./builtin-tools/send-file-tool";

let sendToLive2DWindow: (channel: string, payload?: unknown) => void = () => {};
export function setLive2dWindowSender(sender: typeof sendToLive2DWindow): void {
  sendToLive2DWindow = sender;
}

// ── 注册（顺序 = 原 built-in-tools.ts 的字面顺序，勿重排）─────────────
toolRegistry.register(fetchUrlTool);
toolRegistry.register(downloadFileTool);
toolRegistry.register(readImageUrlTool);
toolRegistry.register(runShellTool);
// run_shell 的后台配套工具：紧跟其后注册，工具目录里相邻展示
toolRegistry.register(shellJobTool);
toolRegistry.register(runVerificationTool);
toolRegistry.register(installMcpServerTool);
logger.info(LogTag.BuiltinTools, "registered: fetch_url / download_file / run_shell / install_mcp_server");
toolRegistry.register(weatherTool);
toolRegistry.register(webSearchTool);
toolRegistry.register(createPlayLive2DActionTool({ sendToLive2DWindow }));

// ── 文件搜索·呈现·打开·发回渠道（追加在末尾，不影响上方 10 个的相对顺序/快照）──
// 三者均 risk:fs-read / effectKind:read，只读不修改文件内容。
toolRegistry.register(findFilesTool);
toolRegistry.register(openFileTool);
toolRegistry.register(sendFileTool);
