import {
  CheckOutlined,
  CloseOutlined,
  DeleteOutlined,
  DownOutlined,
  EditOutlined,
  EnterOutlined,
  PaperClipOutlined,
  UnorderedListOutlined,
  UpOutlined,
} from "@ant-design/icons";
import { useEffect, useState } from "react";
import { useTranslation } from "../../../i18n";

export interface PendingQueueDockItem {
  id: string;
  content: string;
  attachmentCount?: number;
}

interface PendingQueueDockProps {
  items: PendingQueueDockItem[];
  adjustmentAvailable: boolean;
  onEdit?: (id: string, content: string) => Promise<boolean>;
  onAdjust?: (id: string) => Promise<boolean>;
  onRemove?: (id: string) => Promise<void> | void;
}

export function PendingQueueDock({
  items,
  adjustmentAvailable,
  onEdit,
  onAdjust,
  onRemove,
}: PendingQueueDockProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState<{ id: string; content: string } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    if (items.length <= 1) setExpanded(false);
    if (editing && !items.some((item) => item.id === editing.id)) setEditing(null);
  }, [editing, items]);

  if (items.length === 0) return null;
  const listVisible = items.length === 1 || expanded || editing !== null;

  async function saveEdit() {
    if (!editing || !editing.content.trim() || !onEdit) return;
    setBusyId(editing.id);
    try {
      if (await onEdit(editing.id, editing.content)) setEditing(null);
    } finally {
      setBusyId(null);
    }
  }

  async function adjust(id: string) {
    if (!onAdjust || !adjustmentAvailable) return;
    setBusyId(id);
    try {
      await onAdjust(id);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="cy-queue-dock" aria-label={t("composer.queueLabel")}>
      {items.length > 1 && (
        <button
          type="button"
          className="cy-queue-dock__header"
          aria-expanded={listVisible}
          onClick={() => setExpanded((value) => !value)}
        >
          <UnorderedListOutlined aria-hidden="true" />
          <span>{t("composer.queueCount", { count: items.length })}</span>
          {listVisible ? <UpOutlined aria-hidden="true" /> : <DownOutlined aria-hidden="true" />}
        </button>
      )}
      {listVisible && (
        <div className="cy-queue-dock__list">
          {items.map((item) => {
            const isEditing = editing?.id === item.id;
            const busy = busyId !== null;
            return (
              <div className="cy-queue-dock__row" key={item.id}>
                {items.length === 1 && <UnorderedListOutlined className="cy-queue-dock__lead" aria-hidden="true" />}
                {isEditing ? (
                  <input
                    className="cy-queue-dock__editor"
                    value={editing.content}
                    autoFocus
                    disabled={busy}
                    aria-label={t("composer.queueEditInput")}
                    onChange={(event) => setEditing({ id: item.id, content: event.currentTarget.value })}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        void saveEdit();
                      } else if (event.key === "Escape") setEditing(null);
                    }}
                  />
                ) : (
                  <button
                    type="button"
                    className="cy-queue-dock__content"
                    title={item.content}
                    disabled={busy}
                    onClick={() => setEditing({ id: item.id, content: item.content })}
                  >
                    <span>{item.content}</span>
                    {Boolean(item.attachmentCount) && (
                      <small><PaperClipOutlined aria-hidden="true" /> {item.attachmentCount}</small>
                    )}
                  </button>
                )}
                <div className="cy-queue-dock__actions">
                  {isEditing ? (
                    <>
                      <button
                        type="button"
                        aria-label={t("composer.queueSave")}
                        title={t("composer.queueSave")}
                        disabled={busy || !editing.content.trim()}
                        onClick={() => void saveEdit()}
                      ><CheckOutlined /></button>
                      <button
                        type="button"
                        aria-label={t("composer.queueCancelEdit")}
                        title={t("composer.queueCancelEdit")}
                        disabled={busy}
                        onClick={() => setEditing(null)}
                      ><CloseOutlined /></button>
                    </>
                  ) : (
                    <>
                      <button
                        type="button"
                        aria-label={t("composer.queueEdit")}
                        title={t("composer.queueEdit")}
                        disabled={busy}
                        onClick={() => setEditing({ id: item.id, content: item.content })}
                      ><EditOutlined /></button>
                      <button
                        type="button"
                        aria-label={t("composer.queueAdjust")}
                        title={adjustmentAvailable ? t("composer.queueAdjust") : t("composer.queueAdjustUnavailable")}
                        disabled={busy || !adjustmentAvailable}
                        onClick={() => void adjust(item.id)}
                      ><EnterOutlined /></button>
                      <button
                        type="button"
                        aria-label={t("composer.removeQueuedMessage")}
                        title={t("composer.removeQueuedMessage")}
                        disabled={busy}
                        onClick={() => void onRemove?.(item.id)}
                      ><DeleteOutlined /></button>
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
