// RightInspector — 统一的右侧挤出式面板容器。
// antd Tabs（editable-card）承载多标签：每个标签可单独关闭（chip 上的 ×），
// 右上角关闭按钮关闭当前活动标签，活动标签关闭后的回退由上层 ChatPage 决定。
//
// 视觉上抹平 antd 的卡片样式，保留"底部粉线"的活动态（见 RightInspector.css）。

import type { ReactNode } from "react";
import { Tabs } from "antd";
import { useTranslation } from "../../../i18n";
import "./RightInspector.css";

export interface InspectorTab {
  id: string;
  label: string;
  /** 阶段色点 class（如 is-review / is-executing / is-completed），不传则不显示 */
  dotClass?: string;
  /** 是否允许关闭（chip 上的 × 和右上角按钮都受它控制）；不传默认可关 */
  closable?: boolean;
  content: ReactNode;
}

export function RightInspector({
  tabs,
  activeTabId,
  onTabChange,
  onCloseTab,
}: {
  tabs: InspectorTab[];
  /** 当前活动标签 ID，不在列表中时回退到第一个标签 */
  activeTabId: string | null;
  onTabChange: (id: string) => void;
  /** 关闭指定标签（chip 上的 × 和右上角按钮共用） */
  onCloseTab: (id: string) => void;
}) {
  const { t } = useTranslation();
  if (tabs.length === 0) return null;
  const active = tabs.find((tab) => tab.id === activeTabId) ?? tabs[0];
  return (
    <aside className="cy-right-inspector" aria-label={t("rightInspector.panelAria")}>
      <Tabs
        type="editable-card"
        hideAdd
        size="small"
        className="cy-right-inspector__tabs"
        activeKey={active.id}
        onChange={onTabChange}
        onEdit={(key, action) => {
          if (action === "remove") onCloseTab(String(key));
        }}
        items={tabs.map((tab) => ({
          key: tab.id,
          closable: tab.closable !== false,
          label: (
            <>
              {tab.dotClass && (
                <span className={`cy-right-inspector__dot ${tab.dotClass}`} aria-hidden="true" />
              )}
              {tab.label}
            </>
          ),
          children: tab.content,
        }))}
        tabBarExtraContent={{
          right: (
            active.closable !== false && (
              <button
                type="button"
                className="cy-right-inspector__close"
                onClick={() => onCloseTab(active.id)}
                aria-label={t("common.close")}
              >
                <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                  <path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="1.75" />
                </svg>
              </button>
            )
          ),
        }}
      />
    </aside>
  );
}
