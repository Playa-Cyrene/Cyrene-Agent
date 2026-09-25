import { Popover, Segmented } from "antd";
import { useEffect, useState } from "react";
import {
  computeReasoningDropdown,
  type ReasoningDropdownItem,
  type ReasoningDropdownView,
} from "../../../../lib/reasoning-dropdown";
import { type ReasoningEffort, type ReasoningPreference } from "../../../../../shared/reasoning";
import { resolveConfiguredReasoningCapability, type ManualReasoningConfig } from "../../../../../shared/manual-reasoning";
import { ReasoningEffortSlider } from "./ReasoningEffortSlider";
import thinkingIconUrl from "../../../assets/status-moods/思考强度.png?url";

interface ReasoningState {
  providerKey: string;
  providerId: string;
  model: string;
  preference?: ReasoningPreference;
  thinkingOverride?: -1 | 0 | 1;
  /** 当前档案解析出的协议（PRO 档仅 Responses 协议显示） */
  transport?: "openai" | "anthropic" | "responses";
  manualReasoning?: ManualReasoningConfig;
  /** 主进程实际解析到的档案 id（会话绑定 / 欢迎页待定 / 默认档案），SET 时原样回传保证读写对称 */
  modelProfileId?: string | null;
}

interface ChatReasoningApi {
  getReasoningState: (payload?: { sessionId?: string; modelProfileId?: string }) => Promise<ReasoningState>;
  setReasoning: (payload: { sessionId?: string; modelProfileId?: string | null; providerKey: string; preference: ReasoningPreference }) => Promise<void>;
}

function reasoningApi(): ChatReasoningApi | undefined {
  return (window as typeof window & { chat?: ChatReasoningApi }).chat;
}

function preferenceKey(preference: ReasoningPreference): string {
  if (preference.proMode) return `${preference.mode}::pro`;
  return `${preference.mode}:${preference.effort ?? ""}:${preference.proMode ? "pro" : ""}`;
}

function preferenceLabel(preference: ReasoningPreference): string {
  if (preference.mode === "auto") return "不可调";
  if (preference.mode === "off") return "off";
  if (preference.proMode) return "PRO";
  return preference.effort ?? "on";
}

function mergeIndependentReasoningSettings(
  selected: ReasoningPreference,
  active: ReasoningPreference | undefined,
  defaultEffort: ReasoningEffort | undefined,
): ReasoningPreference {
  if (selected.proMode) {
    const effort = active?.effort ?? defaultEffort;
    return {
      mode: "on",
      ...(effort ? { effort } : {}),
      ...(!active?.proMode ? { proMode: true } : {}),
    };
  }

  if (selected.mode === "on" && active?.proMode) {
    return { ...selected, proMode: true };
  }

  return selected;
}

function ChevronIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 10 5 5 5-5" /></svg>;
}

export function ReasoningControl({ sessionId, modelProfileId, model }: { sessionId?: string; modelProfileId?: string; model?: string }) {
  const [providerKey, setProviderKey] = useState("");
  const [resolvedProfileId, setResolvedProfileId] = useState<string | null>(null);
  const [defaultEffort, setDefaultEffort] = useState<ReasoningEffort>();
  const [view, setView] = useState<ReasoningDropdownView>();
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  async function refresh() {
    const api = reasoningApi();
    if (!api) return;
    try {
      const state = await api.getReasoningState({ sessionId, modelProfileId });
      setProviderKey(state.providerKey);
      setResolvedProfileId(state.modelProfileId ?? null);
      setDefaultEffort(resolveConfiguredReasoningCapability(state.providerId, state.model, state.manualReasoning).defaultEffort);
      setView(computeReasoningDropdown(state.providerId, state.model, state.preference, state.thinkingOverride, state.transport, state.manualReasoning));
    } catch {
      setView(undefined);
    }
  }

  useEffect(() => { void refresh(); }, [sessionId, modelProfileId, model]);

  const label = `thinking · ${view ? (view.disabled ? view.statusText : preferenceLabel(view.activePreference)) : "载入中"}`;
  const sliderItems = view?.items.filter((item) => item.preference.mode === "off"
    || (item.preference.mode === "on" && !item.preference.proMode)) ?? [];
  const auxiliaryItems = view?.items.filter((item) => item.preference.proMode) ?? [];

  async function select(item: ReasoningDropdownItem): Promise<boolean> {
    const api = reasoningApi();
    if (item.disabled || !api || !providerKey || saving) return false;
    setSaving(true);
    setSaveError(null);
    try {
      const preference = mergeIndependentReasoningSettings(item.preference, view?.activePreference, defaultEffort);
      await api.setReasoning({ sessionId, modelProfileId: resolvedProfileId, providerKey, preference });
      await refresh();
      return true;
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      setSaving(false);
    }
  }

  const panel = (
    <div className="cy-reasoning-panel">
      <strong>thinking intensity</strong>
      <span>available levels for the current model</span>
      {sliderItems.length >= 2 && view ? (
        <>
          <ReasoningEffortSlider
            options={sliderItems}
            activePreference={view.activePreference}
            defaultEffort={defaultEffort}
            active={open}
            busy={saving || view.disabled}
            onSelect={select}
          />
          {auxiliaryItems.length > 0 && (
            <div className="cy-reasoning-panel__auxiliary">
              {auxiliaryItems.map((item) => (
                <button
                  key={preferenceKey(item.preference)}
                  type="button"
                  className={preferenceKey(view.activePreference) === preferenceKey(item.preference) ? "is-active" : undefined}
                  disabled={saving || item.disabled}
                  onClick={() => void select(item)}
                >
                  {item.label}
                </button>
              ))}
            </div>
          )}
        </>
      ) : (
        <Segmented
          block
          size="small"
          disabled={!view || view.disabled || saving}
          value={view ? preferenceKey(view.activePreference) : "loading"}
          options={view ? view.items.map((item) => ({
            label: item.label,
            value: preferenceKey(item.preference),
            disabled: item.disabled,
          })) : [{ label: "载入中", value: "loading", disabled: true }]}
          onChange={(value) => {
            const item = view?.items.find((candidate) => preferenceKey(candidate.preference) === value);
            if (item) void select(item);
          }}
        />
      )}
      {saveError && <div className="cy-reasoning-panel__error" role="alert">{saveError}</div>}
    </div>
  );

  return (
    <Popover
      content={panel}
      trigger="click"
      placement="topRight"
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (nextOpen) void refresh();
      }}
      overlayClassName="cy-reasoning-popover"
    >
      <button type="button" className="cy-composer__agent-button cy-reasoning-control" disabled={!view || view.disabled}>
        <img className="cy-reasoning-icon" src={thinkingIconUrl} alt="" />
        <span>{label}</span>
        <ChevronIcon />
      </button>
    </Popover>
  );
}
