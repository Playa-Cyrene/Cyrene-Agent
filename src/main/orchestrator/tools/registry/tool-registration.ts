import { loadGeneralSettings } from "../../../settings/settings-facade";
import { loadModelSettings } from "../../../settings/model-settings";
import type { GeneralSettings } from "../../../settings/general-settings";
import { registerEmailTools } from "../email-tools";
import { registerGmailTools } from "../gmail-tools";
import type { GmailService } from "../../../email/gmail-service";
import { registerDocumentTools } from "../document-tools";
// fs-tools / built-in-tools 仍依赖模块加载副作用，先集中在此，后续可继续显式化
import "../fs-tools";
import { registerLifeTools, setTranslateConfig } from "../life-tools";
import { registerMomentsTools } from "../moments-tools";
import { registerRecallHistoryTool } from "../history-tools";
import { registerWikiMemoryTools } from "../wiki-memory-tools";
import { registerKnowledgeBaseTools } from "../knowledge-base-tools";
import { registerSearchTextTool } from "../search-text-tools";
import { registerAstGrepTools } from "../ast-grep-tools";
import { toolRegistry } from "./tool-registry";
import { registerTravelTools } from "../travel-tools";
import { registerZCodeFileTools } from "../zcode-file-tools";
import type { LspManager } from "../../../lsp/manager";
import { registerLspTool } from "../lsp-tool";
import "../built-in-tools";

export function syncBuiltInToolToggles(settings: GeneralSettings): void {
  toolRegistry.setEnabled("weather", settings.weatherEnabled);
  toolRegistry.setEnabled("plan_trip", settings.travelEnabled);
}

export function registerAllTools(deps: { lspManager: LspManager; gmailService?: GmailService }): void {
  registerLspTool(deps.lspManager, toolRegistry);
  registerSearchTextTool();
  registerAstGrepTools();
  registerRecallHistoryTool();
  registerWikiMemoryTools();
  registerKnowledgeBaseTools();
  registerDocumentTools();

  setTranslateConfig(() => {
    const s = loadModelSettings();
    return s.apiKey
      ? { provider: s.provider, baseUrl: s.baseUrl, model: s.model, apiKey: s.apiKey, explicitTransport: s.explicitTransport }
      : null;
  });
  registerLifeTools();
  registerZCodeFileTools({
    read: toolRegistry.getById("read_file")!,
    readImage: toolRegistry.getById("read_image")!,
    write: toolRegistry.getById("write_file")!,
    edit: toolRegistry.getById("str_replace")!,
    grep: toolRegistry.getById("search_text")!,
  });
  registerMomentsTools();

  registerTravelTools();
  registerEmailTools();
  if (deps.gmailService) registerGmailTools(deps.gmailService);

  syncBuiltInToolToggles(loadGeneralSettings());
}
