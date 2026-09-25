import { useState } from "react";
import { useTranslation } from "../../i18n";

interface SidebarToggleProps {
  onToggle?: () => void;
}

/**
 * 侧栏收起开关。收起与否不进组件状态，由根节点 .cy-page.is-collapsed
 * 通过 CSS 控制图标方向（布局态走 DOM，点击不触发 React 渲染）。
 */
export function SidebarToggle({ onToggle }: SidebarToggleProps) {
  const { t } = useTranslation();
  const [hovered, setHovered] = useState(false);

  return (
    <button
      className={`cy-sidebar-toggle ${hovered ? "is-hovered" : ""}`}
      onClick={onToggle}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      aria-label={t("ui.toggleSidebar")}
    >
      <svg width="23" height="23" viewBox="0 0 48 48" fill="none">
        {/* 框 - 不变 */}
        <rect x="6" y="6" width="36" height="36" rx="3" stroke="currentColor" strokeWidth="3.5" strokeLinejoin="round" />

        {/* 竖线 */}
        <path
          className="cy-sidebar-line"
          d="M24 6V42"
          stroke="currentColor"
          strokeWidth="3.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />

        {/* 上横线 */}
        <path d="M11 6H36" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" />
        {/* 下横线 */}
        <path d="M11 42H36" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" />

        {/* Chevron */}
        <path
          className="cy-sidebar-chevron"
          d="M32 20L28 24L32 28"
          stroke="currentColor"
          strokeWidth="3.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  );
}
