import { useCallback, useEffect, useRef, useState } from "react";
import type { TermsSnapshot } from "../../../shared/terms-types";

export function sameTermsContent(a: TermsSnapshot | null, b: TermsSnapshot | null): boolean {
  return Boolean(a && b && a.revision === b.revision
    && a.consentVersion === b.consentVersion && a.contentHash === b.contentHash);
}

function isSnapshot(next: unknown): next is TermsSnapshot {
  if (!next || typeof next !== "object") return false;
  const value = next as Partial<TermsSnapshot>;
  return Number.isSafeInteger(value.revision) && typeof value.consentVersion === "string"
    && typeof value.contentHash === "string" && typeof value.accepted === "boolean"
    && Boolean(value.locales?.["zh-CN"] && value.locales?.en && value.locales?.["ja-JP"]);
}

/** 推送先让旧页面失效，再 GET 登记本窗口的可确认快照；慢响应不能覆盖后续更新。 */
export function useTermsSnapshot(enabled = true) {
  const [snapshot, setSnapshot] = useState<TermsSnapshot | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [failed, setFailed] = useState(false);
  const current = useRef<TermsSnapshot | null>(null);
  const alive = useRef(false);
  const requestId = useRef(0);
  const update = useCallback((next: TermsSnapshot) => {
    if (!alive.current || !isSnapshot(next) || (current.current && next.revision < current.current.revision)) return;
    current.current = next;
    setSnapshot(next);
    setLoading(false);
    setFailed(false);
  }, []);
  const refresh = useCallback(async () => {
    const id = ++requestId.current;
    const api = typeof window === "undefined" ? undefined : window.terms;
    if (!alive.current || !enabled) return;
    setLoading(true);
    try {
      if (!api) throw new Error("Terms API unavailable");
      const next = await api.get();
      if (!alive.current || id !== requestId.current) return;
      if (!isSnapshot(next)) throw new Error("Terms snapshot unavailable");
      update(next);
      setLoading(false);
    } catch {
      if (alive.current && id === requestId.current) { setLoading(false); setFailed(true); }
    }
  }, [enabled, update]);
  useEffect(() => {
    alive.current = true;
    if (!enabled) { setLoading(false); return () => { alive.current = false; }; }
    const api = typeof window === "undefined" ? undefined : window.terms;
    let disposed = false;
    const unsubscribe = api?.onUpdated(next => {
      if (disposed) return;
      update(next);
      void refresh();
    });
    void refresh();
    return () => { disposed = true; alive.current = false; ++requestId.current; unsubscribe?.(); };
  }, [enabled, refresh, update]);
  return { snapshot, current, loading, failed, update, refresh };
}
