import type { AdaptationEvidence, RuleMetadata } from "./model-types";
import type { Transport, VendorRegistryEntry } from "./types";
import { getPresetTransportUrl } from "./preset-defaults";

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function httpUrl(value: string): boolean {
  try { return ["http:", "https:"].includes(new URL(value).protocol); } catch { return false; }
}

export function evidenceCoversTransport(evidence: AdaptationEvidence, transport: Transport): boolean {
  // 历史规则保留运行范围，但渲染器必须明确显示未核验。
  return evidence.kind === "legacy" || (evidence.kind === "official"
    ? evidence.transports.includes(transport) : evidence.transport === transport);
}

export function evidenceCoversEndpoint(evidence: AdaptationEvidence, endpoint: string): boolean {
  if (evidence.kind !== "observed") return true;
  const normalize = (value: string) => value.trim().replace(/\/+$/, "").toLowerCase();
  return normalize(evidence.endpoint) === normalize(endpoint);
}

/** 仅维护命令消费，不因旧证据不足而改变应用启动或请求行为。 */
export function validateModelCatalog(entries: readonly VendorRegistryEntry[]): string[] {
  const errors: string[] = [];
  const providers = new Set<string>();
  for (const entry of entries) {
    const id = entry.capability.id;
    if (providers.has(id)) errors.push(`${id}: 重复厂商`);
    providers.add(id);
    if (!entry.presetDefaults || !entry.models?.length) {
      errors.push(`${id}: 缺少预设默认值或型号目录`);
      continue;
    }
    const groups = [
      ["reasoning", entry.reasoningRules.filter((rule) => rule.modelPattern.source !== ".*")],
      ["sampling", entry.samplingRules ?? []],
      ["structuredOutput", entry.structuredOutputRules ?? []],
    ] as const;
    for (const [feature, rules] of groups) {
      rules.forEach((rule, index) => {
        const location = `${id}.${feature}[${index}]`;
        const metadata = rule.metadata;
        if (!metadata) { errors.push(`${location}: 缺少证据元数据`); return; }
        const evidence = metadata.evidence;
        if (evidence.kind === "legacy" && !evidence.note.trim()) errors.push(`${location}: 历史证据说明不能为空`);
        if (evidence.kind === "official" && (!httpUrl(evidence.url) || !validDate(evidence.checkedAt) || !evidence.transports.length)) {
          errors.push(`${location}: 官方证据需要有效 HTTP 链接、日期和适用协议`);
        }
        if (evidence.kind === "observed" && (!evidence.artifact.trim() || !validDate(evidence.checkedAt) || !httpUrl(evidence.endpoint))) {
          errors.push(`${location}: 实测证据需要脱敏记录、日期和端点`);
        }
      });
    }
    const models = new Set<string>();
    for (const item of entry.models) {
      if (models.has(item.model)) errors.push(`${id}.${item.model}: 重复型号`);
      models.add(item.model);
      for (const unknown of item.unknownCapabilities ?? []) {
        if (!unknown.note.trim()) errors.push(`${id}.${item.model}.${unknown.feature}.${unknown.transport}: 未知能力说明不能为空`);
      }
      if (!item.recommendedFor.length) continue;
      const transport = entry.presetDefaults.transport;
      const presetEndpoint = getPresetTransportUrl(entry.presetDefaults, transport);
      const covered = (metadata: RuleMetadata | undefined, endpoint: string) => !!metadata && metadata.status !== "unknown"
        && evidenceCoversTransport(metadata.evidence, transport) && evidenceCoversEndpoint(metadata.evidence, endpoint);
      const reasoning = entry.reasoningRules.find((rule) => rule.modelPattern.test(item.model));
      const sampling = entry.samplingRules?.find((rule) => rule.modelPattern.test(item.model));
      const output = entry.structuredOutputRules?.find((rule) => rule.transport === transport && rule.modelPattern.test(item.model));
      for (const [feature, metadata, endpoint] of [
        ["reasoning", reasoning?.metadata, presetEndpoint],
        ["sampling", sampling?.metadata, presetEndpoint],
        ["structuredOutput", output?.metadata, entry.capability.baseUrl],
      ] as const) {
        const explicitUnknown = item.unknownCapabilities?.some((unknown) => unknown.feature === feature && unknown.transport === transport && unknown.note.trim());
        if (!covered(metadata, endpoint) && !explicitUnknown) {
          errors.push(`${id}.${item.model}.${feature}.${transport}: 缺少覆盖或明确未知说明`);
        }
      }
    }
    if (entry.presetDefaults.defaultVisionModel && !entry.models.some((item) => item.model === entry.presetDefaults!.defaultVisionModel && item.recommendedFor.includes("vision"))) {
      errors.push(`${id}: 默认视觉型号必须属于视觉推荐目录`);
    }
  }
  return errors;
}
