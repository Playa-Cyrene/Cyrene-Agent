import { useCallback, useEffect, useRef, useState } from "react";
import type { TermsSnapshot } from "../../../../shared/terms-types";
import { sameTermsContent, useTermsSnapshot } from "../../hooks/useTermsSnapshot";
import { WelcomeGate } from "./WelcomeGate";

export function StandaloneOnboarding({ onAccepted, updating = false }: {
  onAccepted?: (snapshot: TermsSnapshot) => void;
  updating?: boolean;
} = {}) {
  const [view, setView] = useState<"welcome" | "disclaimer">("welcome");
  const [displayed, setDisplayed] = useState<TermsSnapshot | null>(null);
  const [accepting, setAccepting] = useState(false);
  const [error, setError] = useState("");
  const { snapshot, current, loading, failed, update, refresh } = useTermsSnapshot();
  const pending = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    if (displayed && snapshot && !sameTermsContent(displayed, snapshot)) {
      // 新内容不能借用旧页面的点击；回到阅读入口，明确提示用户重新打开。
      setDisplayed(null);
      setView("welcome");
      setError("onboarding.termsChanged");
    }
  }, [displayed, snapshot]);

  const accept = useCallback(async () => {
    if (pending.current || !mounted.current || loading || view !== "disclaimer") return;
    if (!displayed || !window.terms) { setError("onboarding.termsUnavailable"); return; }
    if (!sameTermsContent(displayed, current.current)) {
      setDisplayed(null);
      setView("welcome");
      setError("onboarding.termsChanged");
      return;
    }
    pending.current = true;
    setAccepting(true);
    setError("");
    try {
      const result = await window.terms.accept({
        revision: displayed.revision,
        consentVersion: displayed.consentVersion,
        contentHash: displayed.contentHash,
      });
      if (!mounted.current) return;
      // 另一窗口可能已经确认；较早失败回包不能撤回随后广播的接受状态。
      if (result?.snapshot && !(sameTermsContent(current.current, result.snapshot)
        && current.current?.accepted && !result.snapshot.accepted)) update(result.snapshot);
      if (result?.error === "changed" || !sameTermsContent(displayed, current.current)) {
        void refresh();
        setDisplayed(null);
        setView("welcome");
        setError("onboarding.termsChanged");
      } else if (result?.ok && result.snapshot?.accepted && sameTermsContent(displayed, result.snapshot)) {
        onAccepted?.(result.snapshot);
        // 成功后保持防重复标记，等待主进程关闭首次启动窗或外层移除遮罩。
        return;
      } else {
        setError("onboarding.saveFailed");
      }
    } catch {
      if (mounted.current) setError("onboarding.saveFailed");
    }
    pending.current = false;
    if (mounted.current) setAccepting(false);
  }, [current, displayed, loading, onAccepted, refresh, update, view]);

  return <WelcomeGate
    view={loading ? "loading" : view}
    accepting={accepting}
    acceptDisabled={!displayed || !sameTermsContent(displayed, snapshot) || failed}
    snapshot={displayed}
    notice={updating ? "onboarding.termsUpdateNotice" : undefined}
    error={error || (failed ? "onboarding.termsUnavailable" : "")}
    onViewDisclaimer={() => {
      if (pending.current) return;
      setDisplayed(current.current);
      setError("");
      setView("disclaimer");
    }}
    onBack={() => { if (!pending.current) { setError(""); setDisplayed(null); setView("welcome"); } }}
    onAccept={() => { void accept(); }}
    onQuit={() => window.cyrene?.quit()}
  />;
}
