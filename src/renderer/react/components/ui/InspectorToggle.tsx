// InspectorToggle — 白色工作区右上角的右侧面板展开/收起按钮。
// 动画语言与左侧导航的 SidebarToggle 同一套：悬停时竖线收缩、箭头浮现；
// 方向镜像：面板展开时箭头朝右（点击收起），面板收起时箭头朝左（点击展开）。

import { useState } from "react";
import { useTranslation } from "../../i18n";
import "./InspectorToggle.css";

interface InspectorToggleProps {
  /** 右侧面板当前是否可见（有任意标签打开） */
  open: boolean;
  onToggle: () => void;
}

export function InspectorToggle({ open, onToggle }: InspectorToggleProps) {
  const { t } = useTranslation();
  const [hovered, setHovered] = useState(false);

  return (
    <button
      className={`cy-inspector-toggle ${open ? "is-open" : ""} ${hovered ? "is-hovered" : ""}`}
      onClick={onToggle}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      aria-label={t("rightInspector.toggle")}
      aria-expanded={open}
    >
      <svg width="20" height="20" viewBox="0 0 48 48" fill="none">
        {/* 框 - 不变 */}
        <rect x="6" y="6" width="36" height="36" rx="3" stroke="currentColor" strokeWidth="3.5" strokeLinejoin="round" />

        {/* 竖线（代表右侧面板的分隔边） */}
        <path
          className="cy-inspector-line"
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

        {/* Chevron：展开时朝右（收起方向），收起时翻转朝左（展开方向） */}
        <path
          className="cy-inspector-chevron"
          d="M16 20L20 24L16 28"
          stroke="currentColor"
          strokeWidth="3.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  );
}
