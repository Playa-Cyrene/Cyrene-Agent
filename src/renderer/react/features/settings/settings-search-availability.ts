import { useEffect, useState } from "react";
import { dayTotalTokens, type UsageReport } from "./usageStatsViewModel";

// 只保留决定显隐的开关，不保存凭据或把设置值加入搜索文本。
export interface SearchAvailability {
  asrEngine?: string;
  ttsEngine?: string;
  emailEnabled?: boolean;
  memoryMode?: string;
  hasVault?: boolean;
  hasWorkspaceSummary?: boolean;
  hasUsage?: boolean;
  hasAmapConfig?: boolean;
  searchEnabled?: boolean;
}

export function isSettingsSearchAvailable(id: string, state: SearchAvailability): boolean {
  const asr: Record<string, string> = { aliyunTitle: "aliyun", mosslandTitle: "mossland", minimaxTitle: "minimax" };
  const tts: Record<string, string> = { minimaxConfig: "minimax", streamingTitle: "minimax", vocalEnhanceTitle: "minimax", gptConfig: "gptsovits", customCloudConfig: "custom-cloud", mimoConfig: "mimo", mosslandConfig: "mossland" };
  if (id.startsWith("settingsPage.asr.") && asr[id.split(".").at(-1)!]) return state.asrEngine === asr[id.split(".").at(-1)!];
  if (id.startsWith("settingsPage.tts.") && tts[id.split(".").at(-1)!]) return state.ttsEngine === tts[id.split(".").at(-1)!];
  if (id === "settingsPage.emailSettings.smtpIdentity" || /^settingsPage\.tools\.(smtpHost|smtpPort|smtpSecure|smtpUser|smtpPass|fromName)$/.test(id)) return state.emailEnabled === true;
  if (id === "settingsPage.tools.amapKey") return state.hasAmapConfig === true;
  if (id === "settingsPage.tools.searchSource") return state.searchEnabled === true;
  if (/^settingsPage\.usage\.(heatmapTitle|trendsTitle|modelsTitle)$/.test(id)) return state.hasUsage === true;
  if (/^settingsPage\.cyrene\.(retrievalTitle|embeddingModel|embeddingDimensions|reranker)$/.test(id)) return state.memoryMode === "vector";
  if (/^settingsPage\.memory\.(summaryTitle|workspaceSummary|sessionSummary)$/.test(id)) return state.memoryMode === "summary" && (id !== "settingsPage.memory.workspaceSummary" || state.hasWorkspaceSummary === true);
  if (id === "settingsPage.memory.l2Title") return state.memoryMode === "vector";
  if (/^settingsPage\.memory\.(l0Title|l1Title|reflectionsTitle|vault\.title|vault\.autoSync)$/.test(id)) return state.memoryMode !== undefined && state.memoryMode !== "wiki" && (id !== "settingsPage.memory.vault.autoSync" || state.hasVault === true);
  return true;
}

export function useSettingsSearchAvailability(open: boolean): SearchAvailability {
  const [state, setState] = useState<SearchAvailability>({});
  useEffect(() => {
    if (!open) return;
    let disposed = false;
    setState({});
    // 每次打开重新读取；关闭或卸载后忽略迟到结果，避免沿用上次配置。
    function read<T>(request: () => Promise<T> | undefined, pick: (value: T) => SearchAvailability) {
      void Promise.resolve().then(request).then((value) => {
        if (!disposed && value !== undefined) setState((current) => ({ ...current, ...pick(value) }));
      }).catch(() => { /* 读取失败时不展示无法确认可见的条件项，页面入口仍可访问。 */ });
    }
    read(() => window.tts?.loadSettings(), (value) => {
      const config = value && typeof value === "object" ? value as Record<string, unknown> : {};
      return { asrEngine: String(config.asrEngine ?? "off"), ttsEngine: String(config.ttsEngine ?? "off") };
    });
    read(() => window.settings?.getGeneral(), (value) => {
      const config = value && typeof value === "object" ? value as Record<string, unknown> : {};
      return { emailEnabled: config.emailEnabled === true, hasAmapConfig: config.weatherSource === "amap" || config.travelEnabled === true, searchEnabled: typeof config.searchEngine === "string" && config.searchEngine !== "off" };
    });
    read(() => window.settings?.getConfig(), (value) => ({ memoryMode: ["off", "summary", "wiki"].includes(value.memoryMode ?? "") ? value.memoryMode : "vector" }));
    read(() => window.memoryPanel?.getVaultConfig(), (value) => ({ hasVault: !!value.vaultPath }));
    read(() => window.memoryPanel?.getSummaryMemory(), (value) => ({ hasWorkspaceSummary: !!value?.workspacePath }));
    const usage = (window as Window & { tokenUsage?: { get: (days: number) => Promise<UsageReport> } }).tokenUsage;
    read(() => usage?.get(366), (value) => ({ hasUsage: value.days.some((day) => dayTotalTokens(day) > 0 || day.requests > 0 || day.attemptedRequests > 0) }));
    return () => { disposed = true; };
  }, [open]);
  return state;
}
