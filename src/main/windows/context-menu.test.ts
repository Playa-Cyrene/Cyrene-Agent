import { beforeEach, describe, expect, it, vi } from "vitest";

/** attachContextMenu 收到的 context-menu 事件参数的最小切片 */
export interface ContextMenuParamsSlice {
  isEditable?: boolean;
  selectionText?: string;
  editFlags?: Record<string, boolean>;
}

const mocks = vi.hoisted(() => ({
  /** 每次右键触发时正在监听的 listener，测试借它模拟事件 */
  contextMenuListeners: [] as Array<(event: unknown, params: ContextMenuParamsSlice) => void>,
  menuTemplates: [] as Array<Array<Record<string, unknown>>>,
  popupCalls: [] as Array<Record<string, unknown>>,
}));

vi.mock("electron", () => ({
  BrowserWindow: class {
    isDestroyed = () => false;
    webContents = {
      on: (event: string, listener: (event: unknown, params: ContextMenuParamsSlice) => void) => {
        if (event !== "context-menu") throw new Error(`unexpected webContents event: ${event}`);
        mocks.contextMenuListeners.push(listener);
      },
    };
  },
  Menu: {
    buildFromTemplate: (template: Array<Record<string, unknown>>) => {
      mocks.menuTemplates.push(template);
      return {
        popup: (options: Record<string, unknown>) => mocks.popupCalls.push(options),
      };
    },
  },
}));

import { BrowserWindow } from "electron";
import { attachContextMenu } from "./context-menu";

/** 新建 mock 窗口、挂菜单、触发一次右键，返回弹出的菜单模板 */
function rightClick(params: ContextMenuParamsSlice): Array<Record<string, unknown>> {
  const window = new BrowserWindow();
  attachContextMenu(window as never);
  const listener = mocks.contextMenuListeners.at(-1);
  if (!listener) throw new Error("context-menu listener was not registered");
  listener({}, params);
  return mocks.menuTemplates.at(-1) ?? [];
}

function itemByLabel(template: Array<Record<string, unknown>>, label: string) {
  const item = template.find((entry) => entry.label === label);
  if (!item) throw new Error(`menu item not found: ${label}`);
  return item;
}

beforeEach(() => {
  mocks.contextMenuListeners.length = 0;
  mocks.menuTemplates.length = 0;
  mocks.popupCalls.length = 0;
});

describe("attachContextMenu", () => {
  it("输入框右键：给出编辑菜单，enabled 跟随 editFlags，不含全选", () => {
    const template = rightClick({
      isEditable: true,
      editFlags: { canUndo: true, canRedo: false, canCut: true, canCopy: true, canPaste: false },
    });

    expect(itemByLabel(template, "撤销")).toMatchObject({ role: "undo", enabled: true });
    expect(itemByLabel(template, "重做")).toMatchObject({ role: "redo", enabled: false });
    expect(itemByLabel(template, "剪切")).toMatchObject({ role: "cut", enabled: true });
    expect(itemByLabel(template, "复制")).toMatchObject({ role: "copy", enabled: true });
    expect(itemByLabel(template, "粘贴")).toMatchObject({ role: "paste", enabled: false });
    expect(template.some((entry) => entry.label === "全选")).toBe(false);
  });

  it("正文有选中文字：只弹复制，且不含编辑类菜单项", () => {
    const template = rightClick({
      isEditable: false,
      selectionText: "hello",
      editFlags: { canCopy: true },
    });

    expect(itemByLabel(template, "复制")).toMatchObject({ role: "copy", enabled: true });
    expect(template.some((entry) => entry.label === "粘贴")).toBe(false);
    expect(template.some((entry) => entry.label === "全选")).toBe(false);
  });

  it("正文无选中文字：不弹菜单", () => {
    rightClick({
      isEditable: false,
      selectionText: "",
      editFlags: { canCopy: true },
    });

    expect(mocks.menuTemplates).toHaveLength(0);
    expect(mocks.popupCalls).toHaveLength(0);
  });

  it("菜单弹在触发事件的窗口上", () => {
    rightClick({ isEditable: false, selectionText: "hello", editFlags: { canCopy: true } });

    expect(mocks.popupCalls).toHaveLength(1);
    expect(mocks.popupCalls[0].window).toBeInstanceOf(BrowserWindow);
  });
});
