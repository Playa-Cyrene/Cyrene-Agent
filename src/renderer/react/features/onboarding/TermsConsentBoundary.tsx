import { useEffect, useRef, type ReactNode } from "react";
import type { TermsSnapshot } from "../../../../shared/terms-types";
import { useTermsSnapshot } from "../../hooks/useTermsSnapshot";
import { useTranslation } from "../../i18n";
import { StandaloneOnboarding } from "./StandaloneOnboarding";
import "./TermsConsentBoundary.css";

/** 遮罩不替换工作区组件，保留草稿、会话和已完成操作；运行门禁仍由主进程负责。 */
export function TermsConsentBoundary({ children }: { children: ReactNode }) {
  const { snapshot, update } = useTermsSnapshot();
  const blocked = !snapshot?.accepted;
  return <>
    <div className="cy-terms-workspace" inert={blocked} aria-hidden={blocked || undefined}>{children}</div>
    {blocked && <ConsentDialog onAccepted={update} />}
  </>;
}

function ConsentDialog({ onAccepted }: { onAccepted: (snapshot: TermsSnapshot) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const { t } = useTranslation();
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    // 原生模态顶层同时隔离 portal 弹窗；无 dialog API 的测试/旧宿主仍由 inert 保护工作区。
    if (typeof element.showModal === "function") element.showModal();
    else element.setAttribute("open", "");
    // 运行中弹出时不聚焦“退出”按钮，避免用户正在输入的 Enter 意外退出应用。
    element.focus({ preventScroll: true });
    return () => { if (element.open && typeof element.close === "function") element.close(); };
  }, []);
  return <dialog ref={dialog} className="cy-terms-dialog" aria-modal="true" tabIndex={-1}
    aria-label={t("onboarding.termsUpdateTitle")} onCancel={event => event.preventDefault()}>
    <StandaloneOnboarding updating onAccepted={onAccepted} />
  </dialog>;
}
