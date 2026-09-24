// 表情包管理弹窗：从旧 sticker-manager 窗口迁移而来。
// 旧版开独立 BrowserWindow（带标题栏/最小化/关闭），现在改成内嵌 Modal 弹窗。
// 复用现有 IPC 通道：window.stickerManager.{getConfig, setEnabled}，与旧版同源。

import { useEffect, useState } from "react";
import { Modal, Spin } from "antd";
import { resolveAsset } from "../../../../shared/renderer-base";
import { useTranslation } from "../../i18n";
import "./StickerManagerModal.css";

interface StickerItem {
  id: string;
  src: string;
  enabled: boolean;
  builtIn?: boolean;
  description?: string;
}

interface StickerManagerApi {
  getConfig: () => Promise<StickerItem[]>;
  setEnabled: (id: string, enabled: boolean) => Promise<StickerItem[] | undefined>;
}

declare global {
  interface Window {
    stickerManager?: StickerManagerApi;
  }
}

export function StickerManagerModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const [items, setItems] = useState<StickerItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [updatingId, setUpdatingId] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    window.stickerManager?.getConfig()
      .then((next) => { if (!cancelled) setItems(next ?? []); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open]);

  async function toggle(item: StickerItem, next: boolean) {
    if (!item.enabled && next === false) return;
    const target = next;
    setUpdatingId(item.id);
    try {
      const updated = await window.stickerManager?.setEnabled(item.id, target);
      if (updated) setItems(updated);
    } finally {
      setUpdatingId(null);
    }
  }

  return (
    <Modal
      rootClassName="cy-settings-theme-modal"
      title={t("settingsPage.stickerManager.title")}
      open={open}
      onCancel={onClose}
      footer={null}
      width={720}
      destroyOnHidden
    >
      {loading ? (
        <div className="cy-sticker-modal__loading"><Spin /></div>
      ) : items.length === 0 ? (
        <div className="cy-sticker-modal__empty">{t("settingsPage.stickerManager.empty")}</div>
      ) : (
        <div className="cy-sticker-modal__grid">
          {items.map((item) => {
            const isOn = item.enabled;
            return (
              <div key={item.id} className={"cy-sticker-modal__card" + (isOn ? "" : " is-off")}>
                <img
                  src={item.src.startsWith("/stickers/") ? resolveAsset(item.src) : item.src}
                  alt={item.description ?? item.id}
                  draggable={false}
                />
                <button
                  type="button"
                  role="switch"
                  aria-checked={isOn}
                  aria-label={t("settingsPage.stickerManager.toggleLabel", { id: item.id })}
                  disabled={updatingId === item.id}
                  className={"cy-sticker-modal__pill" + (isOn ? " is-on" : "")}
                  onClick={() => void toggle(item, !isOn)}
                >
                  <span className="cy-sticker-modal__pill-knob" />
                </button>
                {item.builtIn && <span className="cy-sticker-modal__badge">{t("settingsPage.stickerManager.builtin")}</span>}
                <span className="cy-sticker-modal__id">{item.description || item.id}</span>
              </div>
            );
          })}
        </div>
      )}
    </Modal>
  );
}