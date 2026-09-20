import { Popover, Segmented } from "antd";
import { useEffect, useState } from "react";
import { useTranslation } from "../../../i18n";
import {
  computeReasoningDropdown,
  type ReasoningDropdownView,
} from "../../../../lib/reasoning-dropdown";
import type { ReasoningPreference } from "../../../../../shared/reasoning";
import thinkingIconUrl from "../../../assets/status-moods/思考强度.png?url";

interface ReasoningState {
  providerKey: string;
  providerId: string;
  model: string;
  preference?: ReasoningPreference;
  thinkingOverride?: -1 | 0 | 1;
  /** 当前档案解析出的协议（PRO 档仅 Responses 协议显示） */
  transport?: "openai" | "anthropic" | "responses";
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
  return `${preference.mode}:${preference.effort ?? ""}:${preference.proMode ? "pro" : ""}`;
}

function preferenceLabel(preference: ReasoningPreference): string {
  if (preference.mode === "auto") return "auto";
  if (preference.mode === "off") return "off";
  if (preference.proMode) return "PRO";
  return preference.effort ?? "on";
}

function ChevronIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 10 5 5 5-5" /></svg>;
}

export function ReasoningControl({ sessionId, modelProfileId }: { sessionId?: string; modelProfileId?: string }) {
  const { t } = useTranslation();
  const [providerKey, setProviderKey] = useState("");
  const [resolvedProfileId, setResolvedProfileId] = useState<string | null>(null);
  const [view, setView] = useState<ReasoningDropdownView>();
  const [open, setOpen] = useState(false);

  async function refresh() {
    const api = reasoningApi();
    if (!api) return;
    try {
      const state = await api.getReasoningState({ sessionId, modelProfileId });
      setProviderKey(state.providerKey);
      setResolvedProfileId(state.modelProfileId ?? null);
      setView(computeReasoningDropdown(state.providerId, state.model, state.preference, state.thinkingOverride, state.transport));
    } catch {
      setView(undefined);
    }
  }

  useEffect(() => { void refresh(); }, [sessionId, modelProfileId]);

  const activeKey = view ? preferenceKey(view.activePreference) : "auto:";
  const label = `thinking · ${preferenceLabel(view?.activePreference ?? { mode: "auto" })}`;

  async function select(value: string | number) {
    const item = view?.items.find((candidate) => preferenceKey(candidate.preference) === value);
    const api = reasoningApi();
    if (!item || item.disabled || !api || !providerKey) return;
    await api.setReasoning({ sessionId, modelProfileId: resolvedProfileId, providerKey, preference: item.preference });
    await refresh();
    setOpen(false);
  }

  const panel = (
    <div className="cy-reasoning-panel">
      <strong>thinking intensity</strong>
      <span>available levels for the current model</span>
      <Segmented
        block
        size="small"
        disabled={!view || view.disabled}
        value={activeKey}
        options={(view?.items ?? [{ label: t("reasoning.followModel"), preference: { mode: "auto" as const }, disabled: true }]).map((item) => ({
          label: preferenceLabel(item.preference),
          value: preferenceKey(item.preference),
          disabled: item.disabled,
        }))}
        onChange={select}
      />
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
      <button type="button" className="cy-composer__agent-button cy-reasoning-control" disabled={view?.disabled}>
        <img className="cy-reasoning-icon" src={thinkingIconUrl} alt="" />
        <span>{label}</span>
        <ChevronIcon />
      </button>
    </Popover>
  );
}
