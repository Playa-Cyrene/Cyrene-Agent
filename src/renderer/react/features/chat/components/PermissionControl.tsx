import { Alert, Popover } from "antd";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "../../../i18n";
import { FullAccessConfirmation } from "../../../components/ui/FullAccessConfirmation";

type PermissionLevel = "project-read-only" | "read-only" | "scoped" | "per-action" | "full";

interface PermissionSettingsApi {
  getPermissionLevel?: () => Promise<{ level: PermissionLevel }>;
  setPermissionLevel?: (level: PermissionLevel) => Promise<{ ok: boolean; level?: PermissionLevel }>;
}

// 只存 i18n key（t() 不能出现在模块顶层常量里），展示文案在组件内求值。
const PERMISSION_OPTIONS: ReadonlyArray<{ level: PermissionLevel; labelKey: string }> = [
  { level: "project-read-only", labelKey: "permission.levelProjectReadOnly" },
  { level: "read-only", labelKey: "permission.levelReadOnly" },
  { level: "scoped", labelKey: "permission.levelScoped" },
  { level: "per-action", labelKey: "permission.levelPerAction" },
  { level: "full", labelKey: "permission.levelFull" },
];

function permissionApi(): PermissionSettingsApi | undefined {
  return (window as typeof window & { settings?: PermissionSettingsApi }).settings;
}

function PermissionIcon({ level }: { level: PermissionLevel }) {
  if (level === "scoped") {
    return <svg viewBox="0 0 48 48" aria-hidden="true"><path d="M6 9.25564 24.0086 4 42 9.25564V20.0337C42 31.3622 34.7502 41.4194 24.0026 45.0005 13.2521 41.4195 6 31.36 6 20.0287V9.25564Z" /><path d="M14 21h8l2.5 3H34v8H14v-11Z" /></svg>;
  }
  if (level === "per-action") {
    return <svg viewBox="0 0 48 48" aria-hidden="true"><path d="M6 9.25564 24.0086 4 42 9.25564V20.0337C42 31.3622 34.7502 41.4194 24.0026 45.0005 13.2521 41.4195 6 31.36 6 20.0287V9.25564Z" /><circle cx="22" cy="22" r="6" /><path d="m26.5 26.5 5 5" /></svg>;
  }
  if (level === "full") {
    return <svg viewBox="0 0 48 48" aria-hidden="true"><path d="M6 9.25564 24.0086 4 42 9.25564V20.0337C42 31.3622 34.7502 41.4194 24.0026 45.0005 13.2521 41.4195 6 31.36 6 20.0287V9.25564Z" /><path d="M24 15v14" /><circle cx="24" cy="35" r="1.4" fill="currentColor" stroke="none" /></svg>;
  }
  return <svg viewBox="0 0 48 48" aria-hidden="true"><path d="M6 9.25564 24.0086 4 42 9.25564V20.0337C42 31.3622 34.7502 41.4194 24.0026 45.0005 13.2521 41.4195 6 31.36 6 20.0287V9.25564Z" /><path d="m15 23 7 7 12-12" /></svg>;
}

function ChevronIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 10 5 5 5-5" /></svg>;
}

function labelFor(level: PermissionLevel, translate: (key: string) => string): string {
  const option = PERMISSION_OPTIONS.find((item) => item.level === level);
  return translate(option?.labelKey ?? "permission.levelReadOnly");
}

export function PermissionControl() {
  const { t } = useTranslation();
  const [level, setLevel] = useState<PermissionLevel>("read-only");
  const [open, setOpen] = useState(false);

  const [fullAccessOpen, setFullAccessOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const pending = useRef(false);
  const mounted = useRef(true);
  const readVersion = useRef(0);

  async function refresh() {
    const version = ++readVersion.current;
    try {
      const state = await permissionApi()?.getPermissionLevel?.();
      if (mounted.current && version === readVersion.current && state) setLevel(state.level);
    } catch {
      if (mounted.current && version === readVersion.current) setFailed(true);
    }
  }

  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => { mounted.current = false; readVersion.current++; };
  }, []);

  async function apply(nextLevel: PermissionLevel): Promise<boolean> {
    if (pending.current) return false;
    pending.current = true;
    readVersion.current++;
    setSaving(true);
    setFailed(false);
    try {
      const result = await permissionApi()?.setPermissionLevel?.(nextLevel);
      if (!result?.ok) throw new Error("Permission update failed");
      if (mounted.current) {
        setLevel(result.level ?? nextLevel);
        setOpen(false);
      }
      return true;
    } catch {
      if (mounted.current) setFailed(true);
      return false;
    } finally {
      pending.current = false;
      if (mounted.current) setSaving(false);
    }
  }

  async function select(nextLevel: PermissionLevel) {
    // 显示档位可能来自旧读取；显式选择必须交由主进程保存，不能据此吞掉降权。
    if (pending.current) return;
    if (nextLevel === "full") {
      setOpen(false);
      setFullAccessOpen(true);
      return;
    }
    await apply(nextLevel);
  }

  return (<>
    <Popover
      trigger="click"
      placement="topLeft"
      open={open}
      onOpenChange={(nextOpen) => {
        if (pending.current) return;
        setOpen(nextOpen);
        if (nextOpen) void refresh();
      }}
      rootClassName="cy-composer-menu-popover"
      content={
        <div className="cy-permission-panel">
          <strong>{t("permission.panelTitle")}</strong>
          {failed && <Alert role="alert" type="error" message={t("settingsPage.saveFailed")} />}
          <div className="cy-permission-panel__options">
            {PERMISSION_OPTIONS.map((option) => (
              <button
                type="button"
                key={option.level}
                className={`cy-permission-panel__option is-${option.level} ${level === option.level ? "is-active" : ""}`}
                disabled={saving}
                onClick={() => void select(option.level)}
              >
                <PermissionIcon level={option.level} />
                <span>{t(option.labelKey)}</span>
              </button>
            ))}
          </div>
        </div>
      }
    >
      <button type="button" className={`cy-composer__footer-button cy-permission-control is-${level}`}>
        <PermissionIcon level={level} />
        <span>{labelFor(level, t)}</span>
        <ChevronIcon />
      </button>
    </Popover>
    <FullAccessConfirmation open={fullAccessOpen} onCancel={() => setFullAccessOpen(false)} onConfirm={() => apply("full")} />
  </>);
}
