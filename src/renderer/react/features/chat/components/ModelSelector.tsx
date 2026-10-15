import { Popover } from "antd";
import { useEffect, useState } from "react";
import { useTranslation } from "../../../i18n";
import {
  getProfileSelectableModels,
  resolveEffectiveSessionModel,
  resolveSessionProfileBinding,
} from "../../../../../shared/session-model";

interface ModelProfile {
  id: string;
  provider: string;
  displayName?: string;
  model: string;
  /** 档案内可切换的模型清单；缺省 = 单模型档案（子下拉不显示，行为与旧版一致）。 */
  models?: string[];
}
interface ModelCatalogApi {
  listModelProfiles?: () => Promise<{ profiles: ModelProfile[]; defaultModelProfileId?: string }>;
}

/**
 * 对话页两级选择器：档案下拉（凭证 + 清单）+ 模型子下拉（当前模型）。
 * 子下拉仅在选中档案清单长度 > 1 且存在模型选择回调时显示；
 * 当前项 = effectiveSessionModel（raw 失效值不显示，Invariant C），解析一律走
 * shared/session-model 唯一语义源，不在组件内手写。
 */
export function ModelSelector({
  hasSession = true,
  activeProfileId,
  sessionModel,
  onSelect,
  onSelectModel,
}: {
  /** 是否已有会话；欢迎页将默认档案视为显式选择，允许显示暂存模型。 */
  hasSession?: boolean;
  activeProfileId?: string;
  /** 会话 raw model（仅用于解析 effective；legacy 会话为 undefined = 跟随档案默认）。 */
  sessionModel?: string;
  onSelect: (id: string) => void;
  /** 模型选择回调；未传时不显示子下拉。 */
  onSelectModel?: (model: string) => void;
}) {
  const { t } = useTranslation();
  const [profiles, setProfiles] = useState<ModelProfile[]>([]);
  const [defaultProfileId, setDefaultProfileId] = useState<string>();
  const [open, setOpen] = useState(false);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const load = async () => {
    const result = await ((window as typeof window & { settings?: ModelCatalogApi }).settings?.listModelProfiles?.());
    setProfiles(result?.profiles ?? []);
    setDefaultProfileId(result?.defaultModelProfileId);
  };
  useEffect(() => { void load(); }, []);
  const active = profiles.find((item) => item.id === activeProfileId) ?? profiles.find((item) => item.id === defaultProfileId) ?? profiles[0];
  const bindingProfileId = activeProfileId ?? (!hasSession ? defaultProfileId ?? profiles[0]?.id : undefined);
  // effective 解析吃 binding 不吃裸 profile：stale 绑定/失效 raw 值都回退档案默认
  const binding = resolveSessionProfileBinding(
    { modelProfiles: profiles, defaultModelProfileId: defaultProfileId },
    { modelProfileId: bindingProfileId, model: sessionModel },
  );
  const selectable = binding.profile ? getProfileSelectableModels(binding.profile) : [];
  const effectiveModel = binding.profile
    ? resolveEffectiveSessionModel({ modelProfileId: bindingProfileId, model: sessionModel }, binding)
    : undefined;
  const showModelMenu = !!onSelectModel && selectable.length > 1;
  return (
    <>
    <Popover open={open} onOpenChange={(next) => { setOpen(next); if (next) void load(); }} trigger="click" placement="topLeft"
      arrow={false} rootClassName="cy-composer-menu-popover"
      content={<div className="cy-model-selector__menu">{profiles.length ? profiles.map((profile) => <button type="button" key={profile.id} onClick={() => { onSelect(profile.id); setOpen(false); }}><strong>{profile.displayName || profile.provider}</strong><small>{profile.model}</small></button>) : <span>{t("modelSelector.emptyHint")}</span>}</div>}>
      <button type="button" className="cy-composer__agent-button cy-model-selector" title={t("modelSelector.switchTitle")}><span>{active?.displayName || active?.model || t("modelSelector.chooseModel")}</span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 10 5 5 5-5" /></svg></button>
    </Popover>
    {showModelMenu && (
      <Popover open={modelMenuOpen} onOpenChange={setModelMenuOpen} trigger="click" placement="topLeft"
        arrow={false} rootClassName="cy-composer-menu-popover"
        content={<div className="cy-model-selector__menu cy-model-selector__models">{selectable.map((model) => (
          <button type="button" key={model} data-current={model === effectiveModel || undefined} onClick={() => { onSelectModel?.(model); setModelMenuOpen(false); }}>
            <code>{model}</code>
          </button>
        ))}</div>}>
        <button type="button" className="cy-composer__agent-button cy-model-selector cy-model-selector--model" title={t("modelSelector.switchSessionModelTitle")}>
          <code>{effectiveModel ?? t("modelSelector.chooseModel")}</code>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 10 5 5 5-5" /></svg>
        </button>
      </Popover>
    )}
    </>
  );
}
