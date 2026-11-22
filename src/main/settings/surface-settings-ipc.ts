import { IPC } from "../../shared/ipc-channels";
import type { IpcScope } from "../application/ipc-scope";
import { getEffectiveUiTheme } from "../system-ui-theme";
import type { GeneralSettings } from "./general-settings";
import { getPublicModelConfig, listSavedModelProfiles, type ModelSettings } from "./model-settings";

export function registerSurfaceSettingsIpc(ipc: IpcScope, { getGeneralSettings, getModelSettings }: {
  getGeneralSettings(): GeneralSettings;
  getModelSettings(): ModelSettings;
}): void {
  ipc.handle(IPC.SETTINGS_GET_CONFIG, () => getModelSettings());
  ipc.handle(IPC.SETTINGS_MODEL_PROFILES_LIST, () => ({
    profiles: listSavedModelProfiles(getModelSettings()),
    defaultModelProfileId: getModelSettings().defaultModelProfileId,
  }));
  ipc.handle(IPC.SETTINGS_GET_GENERAL, () => getGeneralSettings());
  ipc.handle(IPC.UI_THEME_GET, () => getEffectiveUiTheme(getGeneralSettings().uiTheme));
  ipc.handle(IPC.UI_THEME_RADIUS_GET, () => getGeneralSettings().uiThemeRadius);
  ipc.handle(IPC.MODEL_CONFIG_GET, () => getPublicModelConfig());
}
