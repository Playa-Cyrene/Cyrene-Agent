// 表情包管理弹窗：从旧 sticker-manager 窗口迁移而来。
// 旧版开独立 BrowserWindow（带标题栏/最小化/关闭），现在改成内嵌 Modal 弹窗。
// 复用现有 IPC 通道：window.stickerManager，与旧版同源。

import { useEffect, useRef, useState } from "react";
import { Alert, Button, Modal, Spin } from "antd";
import type { StickerConfigItem } from "../../../../shared/sticker-types";
import { resolveAsset } from "../../../../shared/renderer-base";
import { useTranslation } from "../../i18n";
import "./StickerManagerModal.css";

type StickerItem = StickerConfigItem;

interface StickerManagerApi {
  getConfig: () => Promise<StickerItem[]>;
  setEnabled: (id: string, enabled: boolean) => Promise<StickerItem[] | undefined>;
  deleteSticker: (id: string) => Promise<StickerItem[]>;
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
  const [deleteTarget, setDeleteTarget] = useState<StickerItem | null>(null);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const mutation = useRef<Promise<void> | null>(null);
  const pendingError = useRef<string | null>(null);

  useEffect(() => {
    const current = ++generation.current;
    setDeleteTarget(null);
    setError(null);
    if (!open) return;
    setLoading(true);
    setItems([]);
    // 关闭不会撤销已提交的 IPC；重开时等它结束，再读取持久化后的列表。
    void (async () => {
      try {
        await mutation.current;
        if (current !== generation.current) return;
        if (!window.stickerManager) throw new Error(t("settingsPage.stickerManager.unavailable"));
        const next = await window.stickerManager.getConfig();
        if (current === generation.current) {
          setItems(next);
          setError(pendingError.current);
          pendingError.current = null;
        }
      } catch {
        if (current === generation.current) setError(t("settingsPage.stickerManager.loadFailed"));
      } finally {
        if (current === generation.current) {
          setLoading(false);
          setUpdatingId(null);
        }
      }
    })();
    return () => { generation.current++; };
  }, [open]);

  function update(item: StickerItem, deleting: boolean) {
    // ref 在同一事件循环内即生效，防止双击或切换与删除并发覆盖整份列表。
    if (mutation.current || loading || !open || (deleting && item.builtIn)) return;
    const current = generation.current;
    setUpdatingId(item.id);
    setError(null);
    pendingError.current = null;
    mutation.current = Promise.resolve().then(async () => {
      try {
        if (!window.stickerManager) throw new Error(t("settingsPage.stickerManager.unavailable"));
        const updated = deleting
          ? await window.stickerManager.deleteSticker(item.id)
          : await window.stickerManager.setEnabled(item.id, !item.enabled);
        if (!Array.isArray(updated)) throw new Error(t("settingsPage.stickerManager.unavailable"));
        if (current === generation.current) {
          setItems(updated);
          setDeleteTarget(null);
        }
      } catch (err) {
        const message = t(deleting ? "settingsPage.stickerManager.deleteFailed" : "settingsPage.stickerManager.updateFailed", {
          error: err instanceof Error ? err.message : String(err),
        });
        if (current === generation.current) {
          setError(message);
          setDeleteTarget(null);
        } else {
          // 隐藏期间失败也应在重开时告知，不能只恢复列表而丢失错误。
          pendingError.current = message;
        }
      } finally {
        mutation.current = null;
        if (current === generation.current) setUpdatingId(null);
      }
    });
  }

  return (
    <><Modal
      rootClassName="cy-settings-theme-modal"
      title={t("settingsPage.stickerManager.title")}
      open={open}
      onCancel={onClose}
      footer={null}
      width={720}
      destroyOnHidden
    >
      {error && <Alert type="error" showIcon title={error} role="alert" />}
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
                  disabled={updatingId !== null || deleteTarget !== null}
                  className={"cy-sticker-modal__pill" + (isOn ? " is-on" : "")}
                  onClick={() => update(item, false)}
                >
                  <span className="cy-sticker-modal__pill-knob" />
                </button>
                {item.builtIn && <span className="cy-sticker-modal__badge">{t("settingsPage.stickerManager.builtin")}</span>}
                <span className="cy-sticker-modal__id">{item.description || item.id}</span>
                {item.builtIn === false && (
                  <Button
                    type="text"
                    danger
                    size="small"
                    disabled={updatingId !== null || deleteTarget !== null}
                    aria-label={t("settingsPage.stickerManager.deleteLabel", { id: item.id })}
                    onClick={() => { setError(null); setDeleteTarget(item); }}
                  >{t("settingsPage.stickerManager.delete")}</Button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </Modal>
    <Modal
      rootClassName="cy-settings-theme-modal"
      title={t("settingsPage.stickerManager.deleteTitle")}
      open={open && deleteTarget !== null}
      onCancel={() => { if (!mutation.current) setDeleteTarget(null); }}
      onOk={() => { if (deleteTarget) update(deleteTarget, true); }}
      okText={t("settingsPage.stickerManager.delete")}
      cancelText={t("settingsPage.stickerManager.cancel")}
      okButtonProps={{ danger: true }}
      confirmLoading={updatingId !== null}
      cancelButtonProps={{ disabled: updatingId !== null }}
      closable={updatingId === null}
      keyboard={updatingId === null}
      mask={{ closable: updatingId === null }}
      destroyOnHidden
    >
      <p>{t("settingsPage.stickerManager.deleteConfirm", { id: deleteTarget?.id })}</p>
    </Modal></>
  );
}
