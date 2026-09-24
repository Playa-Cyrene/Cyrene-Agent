export interface WindowVisibilitySettings {
  sidebarVisible: boolean;
}

export function normalizeWindowVisibilitySettings(input: Partial<WindowVisibilitySettings> | null | undefined): WindowVisibilitySettings {
  return {
    sidebarVisible: input?.sidebarVisible === undefined ? true : Boolean(input.sidebarVisible),
  };
}
