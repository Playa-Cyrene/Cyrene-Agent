type WorkArea = Pick<Electron.Rectangle, "x" | "y" | "width" | "height">;

/** 根据当前显示器的可用区域计算主工作区的首次打开尺寸与位置。 */
export function getWorkspaceInitialBounds(workArea: WorkArea): Electron.Rectangle {
  const width = Math.min(workArea.width, 1920, Math.max(960, Math.round(workArea.width * 0.84)));
  const height = Math.min(workArea.height, 1200, Math.max(540, Math.round(workArea.height * 0.86)));

  return {
    x: workArea.x + Math.floor((workArea.width - width) / 2),
    y: workArea.y + Math.floor((workArea.height - height) / 2),
    width,
    height,
  };
}
