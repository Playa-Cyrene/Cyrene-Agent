// Diff Review 卡片 — 把写文件工具返回的 changes: ToolFileChange[]
// 渲染成 "文件 +x/-y" 审查视图（GitHub PR Files changed 的紧凑版）。
//
// 结构：汇总头（N 个文件 + 总增删）→ 文件行（kind 徽标 + 路径 + 增删统计）
// → 点击展开色块 diff 行（绿=新增 红=删除 灰=上下文 蓝=hunk 头）。

import { useCallback, useContext, useEffect, useState, type MouseEvent } from "react";
import { useTranslation } from "../../../i18n";
import type { ToolDiffLine, ToolFileChange } from "../../../../../shared/chat-types";
import { chatStore } from "../pages/chat-page-bridge";
import { copyTextToClipboard } from "./CopyButton";
import { FileLinkContext } from "./FileLinkContext";
import "./RunExperience.css";

// 只存 i18n key（t() 不能出现在模块顶层常量里），展示文案在组件内求值。
const KIND_LABEL_KEYS: Record<ToolFileChange["kind"], string> = {
  added: "fileChange.kindAdded",
  modified: "fileChange.kindModified",
  deleted: "fileChange.kindDeleted",
  renamed: "fileChange.kindRenamed",
};

const KIND_CLASS: Record<ToolFileChange["kind"], string> = {
  added: "is-added",
  modified: "is-modified",
  deleted: "is-deleted",
  renamed: "is-renamed",
};

/** 从工具结果 JSON 提取合法的 changes 数组；非 JSON / 无 changes 返回 null */
export function extractFileChanges(result: string): ToolFileChange[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(result);
  } catch {
    return null;
  }
  const changes = (parsed as { changes?: unknown } | null)?.changes;
  if (!Array.isArray(changes) || changes.length === 0) return null;
  for (const item of changes) {
    const c = item as Partial<ToolFileChange> | null;
    if (
      typeof c?.file !== "string" ||
      !c.file ||
      (c.kind !== "added" && c.kind !== "modified" && c.kind !== "deleted" && c.kind !== "renamed") ||
      typeof c.insertions !== "number" ||
      typeof c.deletions !== "number"
    ) {
      return null;
    }
  }
  return changes as ToolFileChange[];
}

/** 工作区根 + 相对路径 → 展示用绝对路径（Windows 用反斜杠，其他平台正斜杠） */
function joinDisplayPath(workspaceRoot: string, relPath: string): string {
  if (navigator.userAgent.includes("Windows")) {
    return `${workspaceRoot}\\${relPath.replaceAll("/", "\\")}`;
  }
  return `${workspaceRoot}/${relPath}`;
}

export function FileChangeCard({ changes }: { changes: ToolFileChange[] }) {
  const { t } = useTranslation();
  // 文件卡片挂在消息列表里，经 FileLinkContext 拿到会话与工作区环境
  const { sessionId, workspaceRoot } = useContext(FileLinkContext);
  const [menu, setMenu] = useState<{ file: string; x: number; y: number } | null>(null);

  // 菜单打开期间：点菜单外 / Esc / 页面滚动 / 窗口失焦时关闭
  useEffect(() => {
    if (!menu) return;
    const onPointerDown = (event: PointerEvent) => {
      if ((event.target as HTMLElement).closest(".cy-file-change-card__menu")) return;
      setMenu(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenu(null);
    };
    const close = () => setMenu(null);
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("wheel", close, { passive: true });
    window.addEventListener("blur", close);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("wheel", close);
      window.removeEventListener("blur", close);
    };
  }, [menu]);

  const openRowMenu = useCallback((event: MouseEvent, file: string) => {
    event.preventDefault();
    event.stopPropagation();
    // 贴边收缩，防止菜单被窗口边缘裁掉
    const x = Math.min(event.clientX, window.innerWidth - 200);
    const y = Math.min(event.clientY, window.innerHeight - 160);
    setMenu({ file, x, y });
  }, []);

  const runMenuAction = useCallback(
    async (action: "open" | "reveal" | "copyRel" | "copyAbs", file: string) => {
      setMenu(null);
      if (action === "open" || action === "reveal") {
        // 打开/定位由主进程执行并校验路径；失败（含文件已删除）静默，不打断聊天
        if (!sessionId) return;
        const result = await chatStore()?.shellFile(sessionId, file, action);
        if (result && !result.ok) console.warn("[FileChangeCard] shellFile 失败:", result.error);
        return;
      }
      if (action === "copyAbs") {
        if (!workspaceRoot) return;
        await copyTextToClipboard(joinDisplayPath(workspaceRoot, file));
        return;
      }
      await copyTextToClipboard(file);
    },
    [sessionId, workspaceRoot],
  );

  const totalAdd = changes.reduce((sum, c) => sum + c.insertions, 0);
  const totalDel = changes.reduce((sum, c) => sum + c.deletions, 0);
  return (
    <section className="cy-file-change-card" aria-label={t("fileChange.panelAria")}>
      <header className="cy-file-change-card__summary">
        <span className="cy-file-change-card__title">
          {t("fileChange.summary", { count: changes.length })}
        </span>
        <span className="cy-file-change-card__stat is-add">+{totalAdd}</span>
        <span className="cy-file-change-card__stat is-remove">−{totalDel}</span>
      </header>
      {changes.map((change) => (
        <FileChangeRow
          key={`${change.kind}:${change.file}`}
          change={change}
          onContextMenu={(event) => openRowMenu(event, change.file)}
        />
      ))}
      {menu && (
        <div
          className="cy-file-change-card__menu"
          style={{ position: "fixed", left: menu.x, top: menu.y }}
          role="menu"
        >
          {sessionId && (
            <>
              <button type="button" role="menuitem" onClick={() => void runMenuAction("open", menu.file)}>
                {t("fileChange.menuOpen")}
              </button>
              <button type="button" role="menuitem" onClick={() => void runMenuAction("reveal", menu.file)}>
                {t("fileChange.menuReveal")}
              </button>
            </>
          )}
          <button type="button" role="menuitem" onClick={() => void runMenuAction("copyRel", menu.file)}>
            {t("fileChange.menuCopyRelPath")}
          </button>
          {workspaceRoot && (
            <button type="button" role="menuitem" onClick={() => void runMenuAction("copyAbs", menu.file)}>
              {t("fileChange.menuCopyAbsPath")}
            </button>
          )}
        </div>
      )}
    </section>
  );
}

function FileChangeRow({
  change,
  onContextMenu,
}: {
  change: ToolFileChange;
  onContextMenu: (event: MouseEvent) => void;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const hasDiff = Boolean(change.diff && change.diff.length > 0);
  const dirEnd = change.file.lastIndexOf("/");
  const dir = dirEnd > 0 ? change.file.slice(0, dirEnd + 1) : "";
  const base = dirEnd > 0 ? change.file.slice(dirEnd + 1) : change.file;

  const rowBody = (
    <>
      <span className={`cy-file-change-card__kind ${KIND_CLASS[change.kind]}`}>
        {t(KIND_LABEL_KEYS[change.kind])}
      </span>
      <span className="cy-file-change-card__path" title={change.file}>
        {dir && <span className="cy-file-change-card__dir">{dir}</span>}
        <span className="cy-file-change-card__base">{base}</span>
      </span>
      <span className="cy-file-change-card__row-stats">
        {change.insertions > 0 && <span className="is-add">+{change.insertions}</span>}
        {change.deletions > 0 && <span className="is-remove">−{change.deletions}</span>}
      </span>
    </>
  );

  return (
    <div className="cy-file-change-card__row-wrapper" onContextMenu={onContextMenu}>
      {hasDiff ? (
        <button
          type="button"
          className={`cy-file-change-card__row is-expandable${expanded ? " is-expanded" : ""}`}
          onClick={() => setExpanded(!expanded)}
          aria-expanded={expanded}
        >
          {rowBody}
          <svg className="cy-file-change-card__chevron" viewBox="0 0 16 16" aria-hidden="true">
            <path d="m4 6 4 4 4-4" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.75" />
          </svg>
        </button>
      ) : (
        <div className="cy-file-change-card__row">{rowBody}</div>
      )}
      {hasDiff && expanded && (
        <div className="cy-file-change-card__diff">
          {change.diff!.map((line, index) => (
            <DiffLineView key={index} line={line} />
          ))}
          {change.truncated && (
            <div className="cy-file-change-card__truncated">{t("fileChange.truncated")}</div>
          )}
        </div>
      )}
    </div>
  );
}

function DiffLineView({ line }: { line: ToolDiffLine }) {
  const marker = line.type === "add" ? "+" : line.type === "remove" ? "−" : line.type === "hunk" ? "@" : " ";
  return (
    <div className={`cy-file-change-card__line is-${line.type}`}>
      <span className="cy-file-change-card__marker" aria-hidden="true">{marker}</span>
      <span className="cy-file-change-card__text">{line.text || " "}</span>
    </div>
  );
}
