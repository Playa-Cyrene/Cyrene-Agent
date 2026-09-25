import { app, BrowserWindow, screen } from "electron";
import path from "node:path";
import { IPC } from "../../shared/ipc-channels";

/** 桌宠窗口的基础尺寸（zoom=1.0 时）。缩放因子改变窗口与模型尺寸，二者同步。 */
export const PET_WINDOW_BASE_WIDTH = 400;
export const PET_WINDOW_BASE_HEIGHT = 500;

/**
 * 仅创建阶段需要的 GeneralSettings 切片。
 * 避免反向依赖 index.ts 中的完整 loadGeneralSettings。
 */
export interface PetWindowSettingsSlice {
  petWindowX?: number;
  petWindowY?: number;
  /** 桌宠缩放因子；离屏判定需按缩放后的实际窗口尺寸计算。 */
  petZoom?: number;
  disclaimerAcceptedVersion?: string;
}

export interface CreatePetWindowContext {
  loadGeneralSettings: () => PetWindowSettingsSlice;
  getCurrentAppIconPath: () => string;
  isDev: boolean;
}

export interface CreatePetWindowOptions {
  /** 窗口 ready 后是否立即 show；默认 true。启动闪屏场景可先隐藏，等闪屏关闭再显示。 */
  showOnReady?: boolean;
}

/**
 * 创建主桌宠窗口。
 * 只负责机械构造：恢复上次坐标、创建 BrowserWindow、加载 URL/文件、
 * 绑定 show/hide 可见性广播。不含业务 getter 注入。
 */
export function createPetWindow(
  ctx: CreatePetWindowContext,
  options: CreatePetWindowOptions = {},
): BrowserWindow {
  const { showOnReady = true } = options;
  const settings = ctx.loadGeneralSettings();
  const transparent = true;
  // 窗口实际尺寸随 petZoom 等比缩放；创建尺寸与离屏判定保持一致。
  const zoom = typeof settings.petZoom === "number" && settings.petZoom > 0 ? settings.petZoom : 1;
  const petWidth = Math.round(PET_WINDOW_BASE_WIDTH * zoom);
  const petHeight = Math.round(PET_WINDOW_BASE_HEIGHT * zoom);
  let restoreX: number | undefined;
  let restoreY: number | undefined;

  if (settings.petWindowX !== undefined && settings.petWindowY !== undefined) {
    const targetBounds = {
      x: settings.petWindowX,
      y: settings.petWindowY,
      width: petWidth,
      height: petHeight,
    };
    const display = screen.getDisplayMatching(targetBounds);
    const wa = display.workArea;

    // 窗口与 workArea 交集至少占窗口的三分之一才使用保存的坐标
    const interW =
      Math.min(targetBounds.x + petWidth, wa.x + wa.width) -
      Math.max(targetBounds.x, wa.x);
    const interH =
      Math.min(targetBounds.y + petHeight, wa.y + wa.height) -
      Math.max(targetBounds.y, wa.y);

    if (interW >= petWidth / 3 && interH >= petHeight / 3) {
      restoreX = settings.petWindowX;
      restoreY = settings.petWindowY;
    } else {
      console.log(
        "[Cyrene] 桌宠保存位置已离屏（仅 " +
          interW + "x" + interH + " 可见），回退到屏幕中央",
      );
    }
  }

  if (restoreX === undefined || restoreY === undefined) {
    // 无保存坐标或已离屏：居中到主屏工作区，避免落在不可见区域
    const wa = screen.getPrimaryDisplay().workArea;
    restoreX = Math.round(wa.x + (wa.width - petWidth) / 2);
    restoreY = Math.round(wa.y + (wa.height - petHeight) / 2);
  }

  const win = new BrowserWindow({
    x: restoreX,
    y: restoreY,
    width: petWidth,
    height: petHeight,
    transparent,
    frame: false,
    skipTaskbar: true,
    resizable: false,
    hasShadow: false,
    show: false,
    icon: ctx.getCurrentAppIconPath(),
    webPreferences: {
      preload: path.join(app.getAppPath(), "dist", "preload", "preload", "index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  if (ctx.isDev) {
    win.loadURL("http://localhost:5173");
  } else {
    win.loadFile(path.join(app.getAppPath(), "dist", "renderer", "index.html"));
  }

  if (!ctx.isDev) {
    win.setIgnoreMouseEvents(true, { forward: true });
  }

  win.on("hide", () => {
    win.webContents.send(IPC.PET_VISIBILITY_CHANGED, false);
  });
  win.on("show", () => {
    win.webContents.send(IPC.PET_VISIBILITY_CHANGED, true);
  });

  win.once("ready-to-show", () => {
    if (showOnReady && !win.isDestroyed()) {
      win.show();
    }
  });

  return win;
}
