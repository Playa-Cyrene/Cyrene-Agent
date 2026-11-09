/**
 * MermaidBlock —— 聊天气泡内的 Mermaid 图渲染。
 *
 * 链路：Mermaid 源码 → 长度检查 → beautiful-mermaid 渲染 → 剥字体外呼 → 消毒 → 图片。
 * 任一环节失败都降级为源码块 + 提示，不白屏不闪烁。
 * 流式期间（streaming=true）只显示占位，流完再正式渲染——半截源码必然语法报错，不值得边流边试。
 */

import { useMemo, useState } from "react";
import { useTranslation } from "../../../i18n";
import { renderMermaidSVG } from "beautiful-mermaid";
import { isOverSourceLimit, sanitizeSvg, stripFontImports, svgImageSrc } from "./svg-sanitize";
import { SvgPreviewModal } from "./SvgPreviewModal";

/** Cyrene 粉白主题：底色米白、主文字暖棕、点缀樱花粉 */
const CYRENE_THEME = {
  bg: "#fffafc",
  fg: "#4a3f44",
  line: "#d9b8c4",
  accent: "#e8a0b4",
  muted: "#9a8a91",
  surface: "#fdf0f3",
  border: "#f0d4dc",
};

type MermaidResult =
  | { kind: "svg"; svg: string }
  | { kind: "fuse" }
  | { kind: "error" };

/** 同步渲染 + 全套消毒；超限或语法不支持返回降级标记 */
export function renderMermaidSafe(code: string): MermaidResult {
  if (isOverSourceLimit(code)) return { kind: "fuse" };
  try {
    const raw = renderMermaidSVG(code, CYRENE_THEME);
    const svg = sanitizeSvg(stripFontImports(raw));
    if (!svg) return { kind: "error" };
    return { kind: "svg", svg };
  } catch {
    // mindmap / gantt / gitGraph 等扩展图型引擎不支持，走降级
    return { kind: "error" };
  }
}

export function MermaidBlock({ code, streaming }: { code: string; streaming?: boolean }) {
  const { t } = useTranslation();
  const [zoomed, setZoomed] = useState(false);
  // 流式期间内容在变，不渲染图（显示占位）；memo 依赖 code，流结束后一次性出图
  const result = useMemo(() => (streaming ? null : renderMermaidSafe(code)), [code, streaming]);

  if (streaming || result === null) {
    return <div className="cy-mermaid cy-mermaid--pending">{t("messageList.mermaidPending")}</div>;
  }

  if (result.kind === "svg") {
    return (
      <>
        <div
          className="cy-mermaid cy-mermaid--zoomable"
          title={t("messageList.diagramZoomHint")}
          // 点击放大查看：气泡内 max-width 压缩会让大图看不清
          onClick={() => setZoomed(true)}
        >
          <img src={svgImageSrc(result.svg)} alt={t("messageList.diagramPreview")} />
        </div>
        <SvgPreviewModal svg={result.svg} open={zoomed} onClose={() => setZoomed(false)} />
      </>
    );
  }

  return (
    <div className="cy-mermaid cy-mermaid--fallback">
      <div className="cy-mermaid__hint">{t("messageList.mermaidFallback")}</div>
      <pre className="cy-mermaid__source">{code}</pre>
    </div>
  );
}
