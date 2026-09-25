// 文件右键菜单（共享组件）：文件卡片行与正文文件链接共用同一套菜单交互。
// 菜单项由调用方组装注入；这里负责贴边定位、点菜单外/Esc/滚动/失焦关闭。
// 样式复用 RunExperience.css 里的 .cy-file-change-card__menu（跨组件共用同一视觉）。

import { useEffect } from "react";
import type { ReactNode } from "react";

export interface FileContextMenuItem {
  key: string;
  label: ReactNode;
  run: () => void | Promise<void>;
}

/** 右键触发点坐标 → 贴边收缩后的菜单坐标（防止被窗口边缘裁掉） */
export function clampMenuPosition(clientX: number, clientY: number): { x: number; y: number } {
  return {
    x: Math.min(clientX, window.innerWidth - 200),
    y: Math.min(clientY, window.innerHeight - 160),
  };
}

export function FileContextMenu({ x, y, items, onClose }: {
  x: number;
  y: number;
  items: FileContextMenuItem[];
  onClose: () => void;
}) {
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if ((event.target as HTMLElement).closest(".cy-file-change-card__menu")) return;
      onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("wheel", onClose, { passive: true });
    window.addEventListener("blur", onClose);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("wheel", onClose);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);

  return (
    <div className="cy-file-change-card__menu" style={{ position: "fixed", left: x, top: y }} role="menu">
      {items.map((item) => (
        <button key={item.key} type="button" role="menuitem" onClick={() => { onClose(); void item.run(); }}>
          {item.label}
        </button>
      ))}
    </div>
  );
}
