import { Image } from "antd";
import { useState } from "react";
import { generatedImageUrl, type GeneratedImageResult } from "../../../../../shared/generated-image";
import "./GeneratedImageCard.css";

export function GeneratedImageCard({ image }: { image: GeneratedImageResult }) {
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");
  async function save() {
    setSaving(true);
    setNotice("");
    try {
      const result = await window.chat?.saveGeneratedImage?.(image.id);
      if (result?.ok) setNotice("原图已保存");
      else if (!result?.cancelled) setNotice(result?.error ?? "当前宿主不支持保存原图");
    } catch { setNotice("保存失败，请重试"); }
    finally { setSaving(false); }
  }
  return <figure className="cy-generated-image" data-image-id={image.id}>
    <Image src={generatedImageUrl(image.id, "preview")} alt="生成图片" loading="lazy" preview={{ src: generatedImageUrl(image.id, "original") }} />
    <figcaption>
      <span>{image.provider ?? "订阅生图"}{image.reused ? " · 已恢复结果" : ""}</span>
      <button type="button" onClick={() => void save()} disabled={saving}>{saving ? "保存中…" : "保存原图"}</button>
    </figcaption>
    {notice && <div role="status">{notice}</div>}
  </figure>;
}
