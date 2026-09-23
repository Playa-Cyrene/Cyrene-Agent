import React from "react";
import { useTranslation } from "../../../i18n";
import compressingPng from "../../../assets/compressing.png";

export interface SessionTakeoverNotice {
  sessionId: string;
}

export function FileDropOverlay({ visible }: { visible: boolean }) {
  const { t } = useTranslation();
  if (!visible) return null;
  return (
    <div className="cy-file-drop-overlay" aria-hidden="true">
      <span>{t("workspaceNotices.fileDropHint")}</span>
    </div>
  );
}

export function RunRecoveryNotices({
  sessionTakeover,
  activeSessionId,
  isRunning,
  onTakeover,
}: {
  sessionTakeover: SessionTakeoverNotice | null;
  activeSessionId?: string;
  isRunning: boolean;
  onTakeover: () => void;
}) {
  const { t } = useTranslation();
  if (isRunning) return null;

  return (
    <>
      {/* 欢迎页 activeSessionId 为 undefined，sessionTakeover 为 null 时
          null?.sessionId 同样是 undefined，直接 === 会误判相等而在欢迎页渲染本卡片 */}
      {sessionTakeover && sessionTakeover.sessionId === activeSessionId && (
        <div className="cy-harness-recovery">
          <span>{t("workspaceNotices.sessionTakeover")}</span>
          <button type="button" onClick={onTakeover}>{t("workspaceNotices.takeoverAndRestart")}</button>
        </div>
      )}
    </>
  );
}

export function ContextCompressionNotice({ visible }: { visible: boolean }) {
  const { t } = useTranslation();
  if (!visible) return null;
  return (
    <div className="cy-compressing-context" aria-live="polite" aria-busy="true">
      <img src={compressingPng} className="cy-compressing-context-icon" alt="" aria-hidden="true" />
      <span>{t("workspaceNotices.compressingContext")}</span>
    </div>
  );
}
