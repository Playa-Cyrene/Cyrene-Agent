import { app, net, protocol, session, type Session } from "electron";
import * as fs from "fs";
import * as path from "path";
import { pathToFileURL } from "url";
import { getStickersDir } from "../sticker-storage";
import { parseLocalStickerFileFromUrl, resolveLocalStickerPath } from "../sticker-protocol";
import { parseMomentMediaUrl, resolveMomentMediaPath } from "../moments/moment-media-protocol";
import { getMomentsMediaRootDir } from "../moments/moments-store";
import { parseLearnExamPageRequest, resolveLearnExamPageAsset } from "./learn-exam-page-protocol";
import { buildLearnExamCsp } from "./learn-exam-csp";
import { createGeneratedImageProtocol } from "./generated-image-protocol";

const LEARN_EXAM_SESSION_PARTITION = "cyrene-learn-exam";

export function getLearnExamPageSession(): Session {
  return session.fromPartition(LEARN_EXAM_SESSION_PARTITION);
}

/**
 * 注册自定义协议的特权。
 *
 * 注意：必须在 app.ready 之前调用，否则 scheme 无法被渲染进程识别。
 */
export function registerPrivilegedSchemes(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: "generated-image", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
    { scheme: "local-sticker", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
    { scheme: "moment-media", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
    { scheme: "cyrene-exam", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
  ]);
}

/**
 * 注册本地用户资源协议的实际处理器。
 *
 * - local-sticker:// 将请求映射到 userData/stickers/ 下的文件
 * - moment-media:// 将请求映射到 userData/moments-media/<postId>/ 下的文件（白名单映射式解析）
 */
export function registerProtocolHandlers(): void {
  protocol.handle("generated-image", createGeneratedImageProtocol(app.getPath("userData")));
  protocol.handle("local-sticker", (request) => {
    const file = parseLocalStickerFileFromUrl(request.url);
    if (!file) return new Response("Invalid sticker URL", { status: 404 });

    const filePath = resolveLocalStickerPath(getStickersDir(), file);
    if (!filePath) return new Response("Invalid sticker path", { status: 403 });

    return net.fetch(pathToFileURL(filePath).toString());
  });

  protocol.handle("moment-media", (request) => {
    const parsed = parseMomentMediaUrl(request.url);
    if (!parsed) return new Response("Invalid moment media URL", { status: 404 });

    const filePath = resolveMomentMediaPath(getMomentsMediaRootDir(), parsed.postId, parsed.file);
    if (!filePath || !fs.existsSync(filePath)) return new Response("Moment media not found", { status: 404 });

    return net.fetch(pathToFileURL(filePath).toString());
  });

  getLearnExamPageSession().protocol.handle("cyrene-exam", async (request) => {
    const isDev = process.env.VITE_DEV === "1";
    const parsed = parseLearnExamPageRequest(request.url, { allowViteDevRequests: isDev });
    if (!parsed) return new Response("Invalid exam page URL", { status: 404 });

    let response: Response;
    if (isDev) {
      const pathname = parsed.kind === "document" ? "learn-exam.html" : parsed.relativePath;
      const search = parsed.kind === "asset" ? parsed.search ?? "" : "";
      // Vite uses Accept to decide whether a .css request should return CSS or
      // its JavaScript HMR wrapper. Preserve the browser's negotiation headers
      // when proxying the custom protocol request.
      response = await net.fetch(`http://localhost:5173/${pathname}${search}`, {
        headers: { Accept: request.headers.get("accept") ?? "*/*" },
      });
    } else {
      const rendererRoot = path.join(app.getAppPath(), "dist", "renderer");
      const filePath = parsed.kind === "document"
        ? path.join(rendererRoot, "learn-exam.html")
        : resolveLearnExamPageAsset(rendererRoot, parsed.relativePath);
      if (!filePath || !fs.existsSync(filePath)) return new Response("Exam page resource not found", { status: 404 });
      response = await net.fetch(pathToFileURL(filePath).toString());
    }

    const headers = new Headers(response.headers);
    headers.set("Content-Security-Policy", buildLearnExamCsp(isDev));
    headers.set("X-Content-Type-Options", "nosniff");
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  });
}
