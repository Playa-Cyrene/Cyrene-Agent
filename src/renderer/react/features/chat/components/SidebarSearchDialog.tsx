import { Input, Modal } from "antd";
import { MessageSquareText, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "../../../i18n";
import type { ChatSessionMeta } from "../../../../../shared/chat-types";
import "./SidebarSearchDialog.css";

interface SidebarSearchDialogProps {
  open: boolean;
  sessions: ChatSessionMeta[];
  activeSessionId?: string;
  onClose: () => void;
  onSelect: (session: ChatSessionMeta) => void;
}

function formatRelativeTime(timestamp: number): string {
  const elapsedMinutes = Math.max(1, Math.round((Date.now() - timestamp) / 60_000));
  const formatter = new Intl.RelativeTimeFormat(document.documentElement.lang || "zh-CN", { numeric: "auto" });
  if (elapsedMinutes < 60) return formatter.format(-elapsedMinutes, "minute");
  const elapsedHours = Math.round(elapsedMinutes / 60);
  if (elapsedHours < 24) return formatter.format(-elapsedHours, "hour");
  return formatter.format(-Math.round(elapsedHours / 24), "day");
}

export function SidebarSearchDialog({ open, sessions, activeSessionId, onClose, onSelect }: SidebarSearchDialogProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (open) setQuery("");
  }, [open]);

  const orderedSessions = useMemo(() => [...sessions].sort((a, b) => b.updatedAt - a.updatedAt), [sessions]);
  const results = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    if (!normalizedQuery) return orderedSessions.slice(0, 6);
    return orderedSessions.filter((session) =>
      `${session.title} ${session.workspaceDisplayName ?? ""} ${session.workspaceRoot ?? ""}`
        .toLocaleLowerCase()
        .includes(normalizedQuery),
    ).slice(0, 20);
  }, [orderedSessions, query]);

  return (
    <Modal
      className="cy-sidebar-search-dialog-modal"
      open={open}
      centered
      width={520}
      title={null}
      footer={null}
      onCancel={onClose}
      destroyOnHidden
    >
      <div className="cy-sidebar-search-dialog">
        <Input
          autoFocus
          allowClear
          prefix={<Search size={16} />}
          placeholder={t("sidebar.searchSessions")}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <section className="cy-sidebar-search-dialog__results" aria-label={query.trim() ? t("sidebar.searchResults") : t("sidebar.recentSessions")}>
          <div className="cy-sidebar-search-dialog__heading">
            {query.trim() ? t("sidebar.searchResults") : t("sidebar.recentSessions")}
          </div>
          {results.length > 0 ? (
            <div className="cy-sidebar-search-dialog__list" role="listbox">
              {results.map((session) => (
                <button
                  key={session.id}
                  className={`cy-sidebar-search-dialog__result ${session.id === activeSessionId ? "is-active" : ""}`}
                  type="button"
                  role="option"
                  aria-selected={session.id === activeSessionId}
                  onClick={() => onSelect(session)}
                >
                  <MessageSquareText size={15} />
                  <span className="cy-sidebar-search-dialog__copy">
                    <span className="cy-sidebar-search-dialog__title">{session.title || t("sidebar.defaultSessionTitle")}</span>
                    <span className="cy-sidebar-search-dialog__workspace">{session.workspaceDisplayName || session.workspaceRoot || session.mode}</span>
                  </span>
                  <time className="cy-sidebar-search-dialog__time" dateTime={new Date(session.updatedAt).toISOString()}>{formatRelativeTime(session.updatedAt)}</time>
                </button>
              ))}
            </div>
          ) : (
            <div className="cy-sidebar-search-dialog__empty">{t("sidebar.noSearchResults")}</div>
          )}
        </section>
      </div>
    </Modal>
  );
}
