import { useState } from "react";
import { Dialog } from "radix-ui";
import { Download, X } from "lucide-react";
import type { GeneratedImageAttachment } from "../../../../../shared/generated-image";
import { t } from "../../../i18n";
import { AttachmentImage } from "./AttachmentImage";
import {
  Attachment,
  AttachmentAction,
  AttachmentActions,
  AttachmentContent,
  AttachmentDescription,
  AttachmentMedia,
  AttachmentTitle,
  AttachmentTrigger,
} from "../../../components/ui/attachment";

export function GeneratedImageAttachments({ attachments }: { attachments: GeneratedImageAttachment[] }) {
  if (attachments.length === 0) return null;
  return (
    <div className="cy-generated-image-attachments" aria-label={t("messageList.generatedImagesLabel")}>
      {attachments.map((attachment) => <GeneratedImageCard key={attachment.id} attachment={attachment} />)}
    </div>
  );
}

function GeneratedImageCard({ attachment }: { attachment: GeneratedImageAttachment }) {
  const [open, setOpen] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [saving, setSaving] = useState(false);
  const [imageUnavailable, setImageUnavailable] = useState(false);

  async function saveOriginal() {
    if (!window.chat?.saveGeneratedImage) return;
    setSaving(true);
    setSaveError("");
    try {
      const result = await window.chat.saveGeneratedImage(attachment.filePath, attachment.name);
      if (!result.ok && !result.cancelled) setSaveError(result.error || t("messageList.generatedImageSaveFailed"));
    } catch {
      setSaveError(t("messageList.generatedImageSaveFailed"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Attachment className="cy-generated-image-card">
      <Dialog.Root open={open} onOpenChange={setOpen}>
        <AttachmentMedia>
          <Dialog.Trigger asChild>
            <AttachmentTrigger aria-label={t("messageList.generatedImagePreview", { name: attachment.name })} disabled={imageUnavailable}>
              {imageUnavailable
                ? <span className="cy-generated-image-card__missing" role="status">{t("messageList.generatedImageUnavailable")}</span>
                : <AttachmentImage attachment={attachment} onUnavailable={() => setImageUnavailable(true)} />}
            </AttachmentTrigger>
          </Dialog.Trigger>
        </AttachmentMedia>
        <AttachmentContent>
          <AttachmentTitle title={attachment.name}>{attachment.name}</AttachmentTitle>
          <AttachmentDescription>{formatBytes(attachment.byteLength)}</AttachmentDescription>
          {imageUnavailable && <span className="cy-generated-image-card__missing-label">{t("messageList.generatedImageUnavailable")}</span>}
          <AttachmentActions>
            <AttachmentAction onClick={() => void saveOriginal()} disabled={saving} aria-label={t("messageList.generatedImageSave")} title={t("messageList.generatedImageSave")}>
              <Download size={15} />
            </AttachmentAction>
          </AttachmentActions>
          {saveError && <p className="cy-generated-image-card__error" role="alert">{saveError}</p>}
        </AttachmentContent>

        <Dialog.Portal>
          <Dialog.Overlay className="cy-generated-image-preview__overlay" />
          <Dialog.Content className="cy-generated-image-preview" aria-describedby={undefined}>
            <header>
              <Dialog.Title>{attachment.name}</Dialog.Title>
              <Dialog.Close className="cy-generated-image-preview__close" aria-label={t("common.close")}><X size={18} /></Dialog.Close>
            </header>
            {imageUnavailable
              ? <div className="cy-generated-image-preview__missing" role="status">{t("messageList.generatedImageUnavailable")}</div>
              : <AttachmentImage attachment={attachment} className="cy-generated-image-preview__image" onUnavailable={() => setImageUnavailable(true)} />}
            <footer>
              {saveError && <p className="cy-generated-image-card__error" role="alert">{saveError}</p>}
              <button type="button" onClick={() => void saveOriginal()} disabled={saving}>
                <Download size={15} />{t("messageList.generatedImageSave")}
              </button>
            </footer>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </Attachment>
  );
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}
