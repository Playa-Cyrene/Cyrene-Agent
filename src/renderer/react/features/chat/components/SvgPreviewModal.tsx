import { useContext, useEffect } from "react";
import { WorkspacePreviewContext } from "./WorkspacePreview";
/**
 * SvgPreviewModal —— Mermaid 图 / SVG 学习卡片的放大预览。
 *
 * 点击聊天气泡里的图卡片打开：全宽 Modal 内按 SVG 原始尺寸展示（解除气泡内的
 * max-width 压缩），容器可滚动，Esc / 点遮罩 / 点右上角关闭。
 * 注入的内容与卡片本体是同一份已消毒字符串，不重复消毒也不引入新输入。
 */

import { Modal } from "antd";
import { useTranslation } from "../../../i18n";

export function SvgPreviewModal({
  svg,
  open,
  onClose,
  centered,
}: {
  svg: string;
  open: boolean;
  onClose: () => void;
  centered?: boolean;
}) {
  const { t } = useTranslation();
  const openWorkspacePreview = useContext(WorkspacePreviewContext);
  useEffect(() => {
    if (open && openWorkspacePreview) {
      openWorkspacePreview({ kind: "svg", svg });
      onClose();
    }
  }, [open, svg, openWorkspacePreview, onClose]);
  if (openWorkspacePreview) return null;
  return (
    <Modal
      centered={centered}
      open={open}
      onCancel={onClose}
      footer={null}
      title={t("messageList.diagramPreview")}
      width="min(1200px, 92vw)"
      className="cy-svg-preview-modal"
      destroyOnHidden
    >
      <div
        className="cy-svg-preview"
        // 与卡片本体同一份已消毒 SVG 字符串
        dangerouslySetInnerHTML={{ __html: svg }}
      />
    </Modal>
  );
}
