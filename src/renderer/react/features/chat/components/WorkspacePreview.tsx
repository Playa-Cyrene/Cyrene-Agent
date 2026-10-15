import { createContext, useEffect, useRef, useState } from "react";
import { Dialog } from "radix-ui";
import { GeneratedImagePreviewPortal } from "./GeneratedImageAttachments";
import { SvgPreviewModal } from "./SvgPreviewModal";
import type { GeneratedImageAttachment } from "../../../../../shared/generated-image";
import { AttachmentImage } from "./AttachmentImage";
import { t } from "../../../i18n";
import "./WorkspacePreview.css";

export type WorkspacePreview =
  | { kind: "image"; attachment: GeneratedImageAttachment }
  | { kind: "svg"; svg: string };
export const WorkspacePreviewContext = createContext<((preview: WorkspacePreview) => void) | null>(null);

export function WorkspacePreviewContent({
  preview,
  active = true,
}: {
  preview: WorkspacePreview;
  active?: boolean;
}) {
  const [expanded, setExpanded] = useState<WorkspacePreview | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const triggerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!active) setExpanded(null);
  }, [active]);
  useEffect(() => {
    setExpanded(null);
    setUnavailable(false);
    setError("");
  }, [preview]);
  // 标签失活或内容替换时立即卸载弹层，避免退出动画遮挡重新显示的网页。
  const zoomed = active && expanded === preview;
  const close = () => {
    setExpanded(null);
    triggerRef.current?.focus();
  };
  async function save() {
    if (preview.kind !== "image" || !window.chat?.saveGeneratedImage) return;
    setSaving(true);
    setError("");
    try {
      const result = await window.chat.saveGeneratedImage(
        preview.attachment.filePath,
        preview.attachment.name,
      );
      if (!result.ok && !result.cancelled)
        setError(result.error || t("messageList.generatedImageSaveFailed"));
    } catch {
      setError(t("messageList.generatedImageSaveFailed"));
    } finally {
      setSaving(false);
    }
  }
  return (
    <section
      className="cy-workspace-preview"
      aria-label={preview.kind === "image" ? preview.attachment.name : t("messageList.diagramPreview")}
    >
      <div className="cy-workspace-preview__body">
        <div
          ref={triggerRef}
          className="cy-workspace-preview__zoom"
          role="button"
          tabIndex={0}
          aria-label={
            preview.kind === "image"
              ? t("messageList.generatedImagePreview", { name: preview.attachment.name })
              : t("messageList.diagramZoomHint")
          }
          onClick={() => {
            if (!unavailable) setExpanded(preview);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              if (!unavailable) setExpanded(preview);
            }
          }}
        >
          {preview.kind === "image" ? (
            <AttachmentImage
              attachment={preview.attachment}
              onUnavailable={() => {
                setUnavailable(true);
                setError(t("messageList.generatedImageUnavailable"));
              }}
            />
          ) : (
            <div className="cy-workspace-preview__svg" dangerouslySetInnerHTML={{ __html: preview.svg }} />
          )}
        </div>
      </div>
      {error && <p role="alert">{error}</p>}
      {preview.kind === "image" && (
        <footer>
          <button onClick={() => void save()} disabled={saving}>
            {t("messageList.generatedImageSave")}
          </button>
        </footer>
      )}
      {zoomed && (
        <WorkspacePreviewContext.Provider value={null}>
          {preview.kind === "image" ? (
            <Dialog.Root
              open
              onOpenChange={(open) => {
                if (!open) close();
              }}
            >
              <GeneratedImagePreviewPortal
                attachment={preview.attachment}
                imageUnavailable={unavailable}
                onUnavailable={() => setUnavailable(true)}
                saveError={error}
                saving={saving}
                onSave={() => void save()}
                onCloseAutoFocus={(event) => {
                  event.preventDefault();
                  if (active) triggerRef.current?.focus();
                }}
              />
            </Dialog.Root>
          ) : (
            <SvgPreviewModal svg={preview.svg} open centered onClose={close} />
          )}
        </WorkspacePreviewContext.Provider>
      )}
    </section>
  );
}
