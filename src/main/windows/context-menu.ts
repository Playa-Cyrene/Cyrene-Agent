import { BrowserWindow, Menu } from "electron";

/**
 * 给窗口挂上右键菜单。
 * Electron 与浏览器不同：右键默认什么都不弹，必须主进程自己构建菜单并 popup。
 * 输入框给编辑菜单（撤销/剪切/复制/粘贴，按编辑能力自动亮灰）；
 * 正文只在选中了文字时弹"复制"，没选中时不弹。
 */
export function attachContextMenu(window: BrowserWindow): void {
  window.webContents.on("context-menu", (_event, params) => {
    if (window.isDestroyed()) return;

    const items: Electron.MenuItemConstructorOptions[] = [];

    if (params.isEditable) {
      // 输入框：编辑菜单，按当前编辑能力亮灰
      items.push(
        { role: "undo", label: "撤销", enabled: params.editFlags.canUndo },
        { role: "redo", label: "重做", enabled: params.editFlags.canRedo },
        { type: "separator" },
        { role: "cut", label: "剪切", enabled: params.editFlags.canCut },
        { role: "copy", label: "复制", enabled: params.editFlags.canCopy },
        { role: "paste", label: "粘贴", enabled: params.editFlags.canPaste },
      );
    } else if (params.selectionText.length > 0) {
      // 正文：选中了文字才有可复制的内容，此时弹"复制"
      items.push({ role: "copy", label: "复制", enabled: params.editFlags.canCopy });
    }

    if (items.length === 0) return;
    Menu.buildFromTemplate(items).popup({ window });
  });
}
