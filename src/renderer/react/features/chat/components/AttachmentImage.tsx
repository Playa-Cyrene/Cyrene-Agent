import { useEffect, useRef, useState } from "react";

export interface AttachmentImageSource {
  name: string;
  filePath?: string;
  previewUrl?: string;
}

/** Reuses the chat IPC image-preview path for stored and temporary attachments. */
export function AttachmentImage({ attachment, className, onUnavailable }: {
  attachment: AttachmentImageSource;
  className?: string;
  onUnavailable?: () => void;
}) {
  const [src, setSrc] = useState(attachment.previewUrl);
  const diskFallbackTriedRef = useRef(false);
  const activeRef = useRef(true);
  const onUnavailableRef = useRef(onUnavailable);

  useEffect(() => {
    onUnavailableRef.current = onUnavailable;
  }, [onUnavailable]);

  function readFromDisk(): void {
    if (!attachment.filePath) {
      onUnavailableRef.current?.();
      return;
    }
    const request = window.chat?.getImagePreview?.(attachment.filePath);
    if (!request) {
      onUnavailableRef.current?.();
      return;
    }
    void request.then((result) => {
      if (!activeRef.current) return;
      if (result.ok && result.dataUrl) setSrc(result.dataUrl);
      else onUnavailableRef.current?.();
    }).catch(() => {
      if (activeRef.current) onUnavailableRef.current?.();
    });
  }

  useEffect(() => {
    activeRef.current = true;
    setSrc(attachment.previewUrl);
    const needsDiskPreview = !attachment.previewUrl || attachment.previewUrl.startsWith("file:");
    diskFallbackTriedRef.current = needsDiskPreview;
    if (needsDiskPreview && attachment.filePath) {
      readFromDisk();
    }
    return () => { activeRef.current = false; };
  }, [attachment.filePath, attachment.previewUrl]);

  function handleImageError(): void {
    if (diskFallbackTriedRef.current) {
      onUnavailableRef.current?.();
      return;
    }
    diskFallbackTriedRef.current = true;
    readFromDisk();
  }

  return <img className={className} src={src} alt={attachment.name} draggable={false} onError={handleImageError} />;
}
