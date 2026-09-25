import { useCallback, useRef, useState } from "react";
import { useTranslation } from "../../../i18n";

interface CopyButtonProps {
  /** 要复制的文本 */
  text: string;
  /** 图标尺寸 */
  size?: number;
  /** 颜色 */
  color?: string;
}

/** 复制文本到剪贴板：优先 navigator.clipboard，权限被拒时回落到隐藏 textarea + execCommand。
 *  供消息复制按钮与文件卡片右键菜单等共用。 */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 权限被拒或无 clipboard 上下文，回落到下面
  }
  // Fallback：临时 textarea + execCommand('copy')
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  ta.style.pointerEvents = "none";
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  document.body.removeChild(ta);
  return ok;
}

export function CopyButton({ text, size = 16, color = "#8e8e93" }: CopyButtonProps) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleClick = useCallback(async () => {
    if (!text.trim()) return;
    const ok = await copyTextToClipboard(text);
    if (!ok) return;
    setCopied(true);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setCopied(false), 1200);
  }, [text]);

  return (
    <button
      type="button"
      className="cy-copy-button"
      onClick={handleClick}
      aria-label={t("common.copy")}
      title={t("common.copy")}
      style={{
        position: "relative",
        width: size,
        height: size,
        border: "none",
        background: "none",
        cursor: "pointer",
        padding: 0,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {/* 复制图标 */}
      <svg
        width={size}
        height={size}
        viewBox="0 0 48 48"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        style={{
          position: "absolute",
          transition: "opacity 0.2s ease, transform 0.2s ease",
          opacity: copied ? 0 : 1,
          transform: copied ? "scale(0.85)" : "scale(1)",
        }}
      >
        <path
          d="M13 12.4316V7.8125C13 6.2592 14.2592 5 15.8125 5H40.1875C41.7408 5 43 6.2592 43 7.8125V32.1875C43 33.7408 41.7408 35 40.1875 35H35.5163"
          stroke={color}
          strokeWidth="4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M32.1875 13H7.8125C6.2592 13 5 14.2592 5 15.8125V40.1875C5 41.7408 6.2592 43 7.8125 43H32.1875C33.7408 43 35 41.7408 35 40.1875V15.8125C35 14.2592 33.7408 13 32.1875 13Z"
          fill="none"
          stroke={color}
          strokeWidth="4"
          strokeLinejoin="round"
        />
      </svg>
      {/* 对号 */}
      <svg
        width={size}
        height={size}
        viewBox="0 0 48 48"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        style={{
          position: "absolute",
          transition: "opacity 0.2s ease, transform 0.2s ease",
          opacity: copied ? 1 : 0,
          transform: copied ? "scale(1)" : "scale(1.15)",
        }}
      >
        <path
          d="M10 24L20 34L40 14"
          stroke="#52c41a"
          strokeWidth="4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  );
}

