// ReviewPanel — 气泡内的 Review 卡片。
//
// 默认折叠：圆角矩形头部（图标 + "N 个文件已更改" + 增删统计 + chevron）。
// 点击头部展开文件列表（kind 徽标 + 路径 + 增删统计），再点收起。
// 点击某个文件 → 调用 onOpenInspector(runId, fileIndex) 打开右侧纯 diff 面板。
// 展开态提供"恢复到运行前"按钮：两步确认（防误触），恢复结果内联展示。

import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "../../../i18n";
import type { ReviewFileChange, ReviewRestoreOutcome, ReviewSnapshot } from "../../../../../shared/review-types";
import reminderIconUrl from "../../../assets/status-moods/提醒.png?url";
import "./ReviewPanel.css";

// 只存 i18n key（t() 不能出现在模块顶层常量里），展示文案在组件内求值。
const KIND_LABEL_KEYS: Record<ReviewFileChange["kind"], string> = {
  modified: "review.kindModified",
  created: "review.kindCreated",
  deleted: "review.kindDeleted",
  renamed: "review.kindRenamed",
  binary: "review.kindBinary",
  "large-text": "review.kindLargeText",
};

const KIND_CLASS: Record<ReviewFileChange["kind"], string> = {
  modified: "is-modified",
  created: "is-created",
  deleted: "is-deleted",
  renamed: "is-renamed",
  binary: "is-binary",
  "large-text": "is-large",
};

function splitPath(filePath: string): { dir: string; base: string } {
  const lastSlash = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  if (lastSlash < 0) return { dir: "", base: filePath };
  return { dir: filePath.slice(0, lastSlash + 1), base: filePath.slice(lastSlash + 1) };
}

export function ReviewPanel({
  runId,
  onOpenInspector,
}: {
  runId: string;
  onOpenInspector?: (runId: string, fileIndex: number, filePath: string) => void;
}) {
  const { t } = useTranslation();
  const [snapshot, setSnapshot] = useState<ReviewSnapshot | null>(null);
  const [expanded, setExpanded] = useState(false);

  // 恢复到运行前：两步确认（idle → confirm → 执行），结果内联展示
  const [restoreConfirming, setRestoreConfirming] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [restoreOutcome, setRestoreOutcome] = useState<ReviewRestoreOutcome | null>(null);

  const handleRestoreClick = async (): Promise<void> => {
    if (restoring) return;
    if (!restoreConfirming) {
      setRestoreConfirming(true);
      return;
    }
    setRestoring(true);
    try {
      const result = await window.review?.restore(runId);
      setRestoreOutcome(result ?? {
        ok: false,
        restored: 0,
        skipped: [],
        failed: [],
        error: "review API 不可用",
      });
    } catch (err) {
      setRestoreOutcome({
        ok: false,
        restored: 0,
        skipped: [],
        failed: [],
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setRestoring(false);
      setRestoreConfirming(false);
    }
  };

  const restoreSummary = useMemo(() => {
    if (!restoreOutcome) return null;
    if (restoreOutcome.error) return t("review.restoreFailed", { reason: restoreOutcome.error });
    if (restoreOutcome.failed.length === 0 && restoreOutcome.skipped.length === 0) {
      return t("review.restoreDone", { count: restoreOutcome.restored });
    }
    return t("review.restorePartial", {
      restored: restoreOutcome.restored,
      skipped: restoreOutcome.skipped.length,
      failed: restoreOutcome.failed.length,
    });
  }, [restoreOutcome, t]);

  useEffect(() => {
    let cancelled = false;
    let retryCount = 0;
    const MAX_RETRIES = 3;
    const RETRY_DELAY = 500;

    const fetchData = async () => {
      if (cancelled) return;
      try {
        const result = await window.review?.get(runId);
        if (cancelled) return;
        if (result && result.files.length > 0) {
          setSnapshot(result);
          return;
        }
      } catch {
        // 忽略，进入重试
      }
      retryCount++;
      if (retryCount < MAX_RETRIES && !cancelled) {
        setTimeout(() => void fetchData(), RETRY_DELAY);
      }
    };

    void fetchData();
    return () => { cancelled = true; };
  }, [runId]);

  const totalAdd = useMemo(
    () => snapshot?.files.reduce((sum, f) => sum + f.additions, 0) ?? 0,
    [snapshot],
  );
  const totalDel = useMemo(
    () => snapshot?.files.reduce((sum, f) => sum + f.deletions, 0) ?? 0,
    [snapshot],
  );

  if (!snapshot) return null;

  return (
    <section className={`cy-review-panel${expanded ? " is-expanded" : ""}`} aria-label={t("review.panelAria")}>
      <button
        type="button"
        className="cy-review-panel__header"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        <img className="cy-review-panel__icon" src={reminderIconUrl} alt="" aria-hidden="true" />
        <span className="cy-review-panel__title">
          {t("review.fileCount", { count: snapshot.files.length })}
        </span>
        <span className="cy-review-panel__stats">
          {totalAdd > 0 && <span className="is-add">+{totalAdd}</span>}
          {totalDel > 0 && <span className="is-remove">−{totalDel}</span>}
        </span>
        <svg className="cy-review-panel__chevron" viewBox="0 0 16 16" aria-hidden="true">
          <path d="m4 6 4 4 4-4" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.75" />
        </svg>
      </button>
      {expanded && (
        <div className="cy-review-panel__list">
          {snapshot.files.map((file, index) => {
            const { dir, base } = splitPath(file.newPath);
            return (
              <button
                key={`${file.kind}:${file.oldPath}:${file.newPath}:${index}`}
                type="button"
                className="cy-review-panel__file-item"
                onClick={() => onOpenInspector?.(runId, index, file.newPath)}
                title={file.newPath}
              >
                <span className={`cy-review-panel__kind ${KIND_CLASS[file.kind]}`}>
                  {t(KIND_LABEL_KEYS[file.kind])}
                </span>
                <span className="cy-review-panel__file-path">
                  {dir && <span className="cy-review-panel__dir">{dir}</span>}
                  <span className="cy-review-panel__base">{base}</span>
                </span>
                <span className="cy-review-panel__file-stats">
                  {file.additions > 0 && <span className="is-add">+{file.additions}</span>}
                  {file.deletions > 0 && <span className="is-remove">−{file.deletions}</span>}
                </span>
                <svg className="cy-review-panel__arrow" viewBox="0 0 16 16" aria-hidden="true">
                  <path d="m6 4 4 4-4 4" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.75" />
                </svg>
              </button>
            );
          })}
          {/* 恢复入口：两步确认，恢复后展示结果摘要 */}
          <div className="cy-review-panel__restore">
            {restoreSummary ? (
              <span className={`cy-review-panel__restore-summary${restoreOutcome?.ok === false ? " is-error" : ""}`}>
                {restoreSummary}
              </span>
            ) : (
              <button
                type="button"
                className={`cy-review-panel__restore-btn${restoreConfirming ? " is-confirming" : ""}`}
                onClick={() => void handleRestoreClick()}
                disabled={restoring}
              >
                {restoring
                  ? t("review.restoreRunning")
                  : restoreConfirming
                    ? t("review.restoreConfirm")
                    : t("review.restoreButton")}
              </button>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
