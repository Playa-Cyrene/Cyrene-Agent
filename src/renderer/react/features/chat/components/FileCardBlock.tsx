// 搜索结果文件卡片 — 把 find_files 工具返回的 files[] 渲染成可点击的文件卡片列表。
//
// 走「工具结果 → 卡片」的确定性路径（和 FileChangeCard 同模式，见 ChatMessageList 的
// ToolResultContent），不依赖模型复述围栏块。点击整行 → shellFile(sessionId, path, "open")
// 用系统默认程序打开（chats:shell-file IPC 支持工作区外绝对路径）；右键菜单复用 FileContextMenu。
//
// 呈现纪律（对齐 find_files 的交互原则）：只列文件名 + 元数据（大小 / 修改时间 / 命中方式），
// 命中内容时最多附一句 snippet 作证据；不展示整段正文（要读全文点行打开即可）。

import { useCallback, useContext, useState, type MouseEvent } from "react";
import { useTranslation } from "../../../i18n";
import { chatStore } from "../pages/chat-page-bridge";
import { FileIcon } from "./file-icon";
import { FileLinkContext } from "./FileLinkContext";
import { FileContextMenu, clampMenuPosition } from "./FileContextMenu";
import "./FileCardBlock.css";

export interface FileCardEntry {
  path: string;
  name: string;
  sizeBytes: number;
  modifiedAt: number;
  ext: string;
  matchedBy: "name" | "content";
  snippet?: string;
  unreadable?: boolean;
}

/** 从 find_files 工具结果 JSON 提取合法的 files 数组；非 JSON / 无合法项返回 null。 */
export function extractFileCards(result: string): FileCardEntry[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(result);
  } catch {
    return null;
  }
  const p = parsed as { files?: unknown; success?: unknown } | null;
  if (!p || p.success === false) return null;
  const files = p.files;
  if (!Array.isArray(files) || files.length === 0) return null;
  const out: FileCardEntry[] = [];
  for (const item of files) {
    const f = item as Partial<FileCardEntry> | null;
    if (
      !f ||
      typeof f.path !== "string" || !f.path ||
      typeof f.name !== "string" || !f.name ||
      typeof f.sizeBytes !== "number" ||
      typeof f.modifiedAt !== "number" ||
      typeof f.ext !== "string" ||
      (f.matchedBy !== "name" && f.matchedBy !== "content")
    ) {
      return null;
    }
    out.push({
      path: f.path,
      name: f.name,
      sizeBytes: f.sizeBytes,
      modifiedAt: f.modifiedAt,
      ext: f.ext,
      matchedBy: f.matchedBy,
      ...(typeof f.snippet === "string" ? { snippet: f.snippet } : {}),
      ...(f.unreadable === true ? { unreadable: true } : {}),
    });
  }
  return out;
}

function humanBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "";
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + " MB";
  return (n / 1024 / 1024 / 1024).toFixed(2) + " GB";
}

export function FileCardBlock({ files }: { files: FileCardEntry[] }) {
  const { t, locale } = useTranslation();
  const { sessionId } = useContext(FileLinkContext);
  const [menu, setMenu] = useState<{ path: string; x: number; y: number } | null>(null);

  const openRowMenu = useCallback((event: MouseEvent, path: string) => {
    event.preventDefault();
    event.stopPropagation();
    const { x, y } = clampMenuPosition(event.clientX, event.clientY);
    setMenu({ path, x, y });
  }, []);

  const runAction = useCallback(
    async (action: "open" | "reveal", path: string) => {
      setMenu(null);
      if (!sessionId) return;
      const result = await chatStore()?.shellFile(sessionId, path, action);
      if (result && !result.ok) console.warn("[FileCardBlock] shellFile 失败:", result.error);
    },
    [sessionId],
  );

  const fmtDate = (ms: number) => {
    try {
      return new Date(ms).toLocaleString(locale || undefined, {
        year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit",
      });
    } catch {
      return new Date(ms).toISOString().slice(0, 16).replace("T", " ");
    }
  };

  return (
    <section className="cy-file-card-block" aria-label={t("fileCard.panelAria")}>
      <header className="cy-file-card-block__summary">
        <span className="cy-file-card-block__title">{t("fileCard.count", { count: files.length })}</span>
        {sessionId && <span className="cy-file-card-block__hint">{t("fileCard.openHint")}</span>}
      </header>
      {files.map((file) => (
        <div
          key={file.path}
          className={`cy-file-card-block__row${sessionId ? " is-actionable" : ""}`}
          role={sessionId ? "button" : undefined}
          tabIndex={sessionId ? 0 : undefined}
          onClick={() => { if (sessionId) void runAction("open", file.path); }}
          onKeyDown={(e) => {
            if (!sessionId) return;
            if (e.key === "Enter" || e.key === " ") { e.preventDefault(); void runAction("open", file.path); }
          }}
          onContextMenu={(e) => openRowMenu(e, file.path)}
        >
          <FileIcon fileName={file.name} className="cy-file-card-block__icon" />
          <div className="cy-file-card-block__main">
            <div className="cy-file-card-block__name" title={file.path}>{file.name}</div>
            <div className="cy-file-card-block__meta">
              <span className="cy-file-card-block__size">{humanBytes(file.sizeBytes)}</span>
              <span className="cy-file-card-block__dot">·</span>
              <span className="cy-file-card-block__time">{fmtDate(file.modifiedAt)}</span>
              <span className={`cy-file-card-block__tag is-${file.matchedBy}`}>
                {file.matchedBy === "content" ? t("fileCard.matchedContent") : t("fileCard.matchedName")}
              </span>
              {file.unreadable && (
                <span className="cy-file-card-block__tag is-unreadable">
                  {file.ext === ".png" || file.ext === ".jpg" || file.ext === ".jpeg" || file.ext === ".gif" || file.ext === ".webp" || file.ext === ".bmp"
                    ? t("fileCard.unreadableImage")
                    : t("fileCard.unreadableOther")}
                </span>
              )}
            </div>
            {file.snippet && (
              <div className="cy-file-card-block__snippet" title={file.snippet}>…{file.snippet}…</div>
            )}
          </div>
        </div>
      ))}
      {menu && sessionId && (
        <FileContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            { key: "open", label: t("fileChange.menuOpen"), run: () => runAction("open", menu.path) },
            { key: "reveal", label: t("fileChange.menuReveal"), run: () => runAction("reveal", menu.path) },
          ]}
        />
      )}
    </section>
  );
}
