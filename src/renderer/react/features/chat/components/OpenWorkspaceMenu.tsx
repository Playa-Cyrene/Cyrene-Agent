// OpenWorkspaceMenu — 工作区右上角的"打开方式"分裂按钮。
// 主按钮 = 上次使用的应用图标（单击直接打开）；chevron 展开应用菜单（图标 + 名称）。
// 应用列表与图标由主进程探测提取并进程内缓存。状态细节照搬 dsh 的处理：
// 忙态延迟 250ms 才显示（快速启动不闪），失败红态 2 秒自动衰减。

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "../../../i18n";
import type { OpenInAppEntry } from "../../../../../shared/open-in-app-types";
import "./OpenWorkspaceMenu.css";

/** 忙态延迟：快速启动不会闪一下"加载中" */
const BUSY_DRESS_DELAY_MS = 250;
/** 失败红态的自动衰减时间 */
const ERROR_DECAY_MS = 2000;

/** 探测列表拿不到时的兜底：至少保证资源管理器可用 */
const EXPLORER_FALLBACK: OpenInAppEntry[] = [{ id: "explorer", name: "资源管理器" }];

/** 应用图标：有真实图标显示 img，没有则显示通用占位方块 */
function AppIcon({ app, size }: { app: OpenInAppEntry | undefined; size: number }) {
  if (app?.icon) {
    return (
      <img
        src={app.icon}
        width={size}
        height={size}
        className="cy-open-workspace__icon"
        alt=""
        aria-hidden="true"
        draggable={false}
      />
    );
  }
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      className="cy-open-workspace__icon"
      aria-hidden="true"
    >
      <rect x="3" y="3" width="18" height="18" rx="5" />
    </svg>
  );
}

interface OpenWorkspaceMenuProps {
  /** 当前会话 id：主进程以此校验工作区绑定，防止越权打开任意路径 */
  sessionId: string;
}

export function OpenWorkspaceMenu({ sessionId }: OpenWorkspaceMenuProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  // null = 尚未拉取（菜单显示检测中提示）
  const [apps, setApps] = useState<OpenInAppEntry[] | null>(null);
  const [preferred, setPreferred] = useState("explorer");
  const [phase, setPhase] = useState<"idle" | "busy" | "error">("idle");
  const inFlight = useRef(false);
  const busyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const errorTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const rootRef = useRef<HTMLDivElement>(null);

  // 组件挂载即后台拉取探测结果（照搬 dsh：页面加载时主动探测一次，
  // 注册表扫描约 1 秒在后台完成，用户点开菜单时列表和图标早已就绪）
  useEffect(() => {
    let cancelled = false;
    window.openInApp
      ?.listApps(sessionId)
      .then((result) => {
        if (cancelled) return;
        if (result.ok) {
          setApps(result.apps);
          setPreferred(result.preferred);
        } else {
          setApps(EXPLORER_FALLBACK);
        }
      })
      .catch(() => {
        if (!cancelled) setApps(EXPLORER_FALLBACK);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  // 点击组件外部即关闭菜单
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  // 卸载时清掉两个状态定时器
  useEffect(() => () => {
    clearTimeout(busyTimer.current);
    clearTimeout(errorTimer.current);
  }, []);

  const entryById = new Map((apps ?? []).map((app) => [app.id, app]));
  // 探测完成前先落到资源管理器（恒可用），主按钮不会点了没反应
  const current = entryById.get(preferred) ?? apps?.[0] ?? EXPLORER_FALLBACK[0];

  const displayName = (app: OpenInAppEntry) =>
    app.id === "explorer" ? t("openWorkspace.appExplorer") : app.name;
  const currentName = current ? displayName(current) : t("openWorkspace.appExplorer");
  const title = phase === "error"
    ? t("openWorkspace.openError")
    : t("openWorkspace.tooltip", { app: currentName });

  const launch = (appId: string): void => {
    if (inFlight.current) return;
    inFlight.current = true;
    // 失败红态的衰减定时器不能在启动中途把状态翻回 idle
    clearTimeout(errorTimer.current);
    clearTimeout(busyTimer.current);
    busyTimer.current = setTimeout(() => setPhase("busy"), BUSY_DRESS_DELAY_MS);
    window.openInApp?.open(sessionId, appId).then(
      (result) => {
        inFlight.current = false;
        clearTimeout(busyTimer.current);
        if (result.ok) {
          setPhase("idle");
          setPreferred(appId);
        } else {
          setPhase("error");
          errorTimer.current = setTimeout(() => setPhase("idle"), ERROR_DECAY_MS);
        }
      },
      () => {
        inFlight.current = false;
        clearTimeout(busyTimer.current);
        setPhase("error");
        errorTimer.current = setTimeout(() => setPhase("idle"), ERROR_DECAY_MS);
      },
    );
  };

  return (
    <div className="cy-open-workspace" ref={rootRef} data-phase={phase}>
      <button
        type="button"
        className="cy-open-workspace__main"
        onClick={() => launch(current.id)}
        disabled={phase === "busy"}
        title={title}
        aria-label={title}
      >
        <AppIcon app={current} size={16} />
      </button>
      <button
        type="button"
        className={`cy-open-workspace__chevron ${open ? "is-open" : ""}`}
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-haspopup="menu"
        title={t("openWorkspace.menuToggle")}
        aria-label={t("openWorkspace.menuToggle")}
      >
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {open && (
        <div className="cy-open-workspace__menu" role="menu">
          {apps === null && <div className="cy-open-workspace__hint">{t("openWorkspace.detecting")}</div>}
          {apps?.map((app) => (
            <button
              type="button"
              role="menuitem"
              key={app.id}
              className={`cy-open-workspace__item ${app.id === preferred ? "is-selected" : ""}`}
              onClick={() => {
                setOpen(false);
                launch(app.id);
              }}
            >
              <AppIcon app={app} size={18} />
              <span className="cy-open-workspace__item-name">{displayName(app)}</span>
              {app.id === preferred && (
                <svg className="cy-open-workspace__check" width="12" height="12" viewBox="0 0 24 24"
                  fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round"
                  strokeLinejoin="round" aria-hidden="true">
                  <path d="M20 6L9 17l-5-5" />
                </svg>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
