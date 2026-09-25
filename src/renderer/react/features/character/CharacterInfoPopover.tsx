import { useCallback, useEffect, useRef, useState } from "react";
import { Phone, Settings2 } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Popover } from "radix-ui";
import { getCharacterAvatar } from "../../character-avatars";
import { CharacterStatusPill } from "../../components/ui/CharacterStatusPill";
import { useTranslation } from "../../i18n";
import {
  characterBridge,
  DEFAULT_RUNTIME_STATE,
  FEELING_ICON,
  FEELING_LABEL_KEY,
  isRuntimeSyncEnabled,
  modelConfigBridge,
  normalizeModelConfig,
  normalizeRuntimeState,
  runtimeStateBridge,
  STATUS_ICON,
  STATUS_LABEL_KEY,
  type ModelConfigSummary,
  type RuntimeState,
} from "./characterRuntime";
import "./CharacterInfoPopover.css";

/** 角色昵称：与 character-avatars / 朋友圈点名名单共用同一标识 */
const CHARACTER_NAME = "昔涟";
/** 悬停多久后浮出（避免鼠标划过时误触） */
const HOVER_OPEN_DELAY = 250;
/** 移出后延时关闭，留出「从触发器移到浮层」的过渡时间 */
const HOVER_CLOSE_DELAY = 160;

function useRuntimeState(): RuntimeState {
  const [state, setState] = useState<RuntimeState>(DEFAULT_RUNTIME_STATE);

  useEffect(() => {
    const bridge = runtimeStateBridge();
    if (!bridge) return;
    let active = true;
    void Promise.resolve(bridge.get())
      .then((value) => { if (active) setState(normalizeRuntimeState(value)); })
      .catch(() => {});
    const off = bridge.onChanged((value) => setState(normalizeRuntimeState(value)));
    return () => {
      active = false;
      off();
    };
  }, []);

  return state;
}

function useModelConfig(): ModelConfigSummary {
  const [config, setConfig] = useState(() => normalizeModelConfig(null));

  useEffect(() => {
    const bridge = modelConfigBridge();
    if (!bridge) return;
    let active = true;
    void Promise.resolve(bridge.get())
      .then((value) => { if (active) setConfig(normalizeModelConfig(value)); })
      .catch(() => {});
    const off = bridge.onChanged((value) => setConfig(normalizeModelConfig(value)));
    return () => {
      active = false;
      off();
    };
  }, []);

  return config;
}

/** 状态 / 心情共用的一行：图标 + 文字；运行态同步关闭时降级为设置引导 */
function TraitLine({ iconSrc, text, disabled = false }: { iconSrc: string; text: string; disabled?: boolean }) {
  return (
    <div className={`cy-character-card__trait${disabled ? " is-disabled" : ""}`}>
      {disabled
        ? <Settings2 className="cy-character-card__trait-icon" size={18} strokeWidth={1.7} aria-hidden="true" />
        : <img className="cy-character-card__trait-icon" src={iconSrc} alt="" draggable={false} />}
      <span className="cy-character-card__trait-text">{text}</span>
    </div>
  );
}

/**
 * 角色信息浮层：悬停预览 + 点击钉住，内容为头像、在线态、状态、心情与通话入口。
 * 外壳交给 radix-ui 的 Popover（焦点、Esc、点外部关闭由它负责），只自己写内容与动效。
 */
export function CharacterInfoPopover() {
  const { t } = useTranslation();
  const reduceMotion = useReducedMotion();
  const state = useRuntimeState();
  const config = useModelConfig();

  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  // 标记本次关闭请求源自触发器本身（点击 / 键盘激活），用于区分「钉住」与「真的关闭」
  const triggerClickRef = useRef(false);
  const hoverOpenTimer = useRef<number | null>(null);
  const hoverCloseTimer = useRef<number | null>(null);

  const clearTimers = useCallback(() => {
    if (hoverOpenTimer.current !== null) {
      window.clearTimeout(hoverOpenTimer.current);
      hoverOpenTimer.current = null;
    }
    if (hoverCloseTimer.current !== null) {
      window.clearTimeout(hoverCloseTimer.current);
      hoverCloseTimer.current = null;
    }
  }, []);

  useEffect(() => clearTimers, [clearTimers]);

  const scheduleClose = useCallback(() => {
    if (pinned) return;
    if (hoverCloseTimer.current !== null) window.clearTimeout(hoverCloseTimer.current);
    hoverCloseTimer.current = window.setTimeout(() => setOpen(false), HOVER_CLOSE_DELAY);
  }, [pinned]);

  const cancelClose = useCallback(() => {
    if (hoverCloseTimer.current === null) return;
    window.clearTimeout(hoverCloseTimer.current);
    hoverCloseTimer.current = null;
  }, []);

  const handleTriggerEnter = useCallback(() => {
    clearTimers();
    hoverOpenTimer.current = window.setTimeout(() => setOpen(true), HOVER_OPEN_DELAY);
  }, [clearTimers]);

  const handleTriggerLeave = useCallback(() => {
    clearTimers();
    scheduleClose();
  }, [clearTimers, scheduleClose]);

  const handleTriggerClick = useCallback(() => {
    triggerClickRef.current = true;
  }, []);

  const handleOpenChange = useCallback((next: boolean) => {
    const viaTriggerClick = triggerClickRef.current;
    triggerClickRef.current = false;

    if (next) {
      // 触发器被点击 / 键盘激活：展开并钉住
      clearTimers();
      setOpen(true);
      setPinned(true);
      return;
    }

    // 悬停浮出后点触发器：转为钉住，不关闭
    if (viaTriggerClick && !pinned) {
      setPinned(true);
      return;
    }

    // 其余关闭请求（再次点击触发器 / Esc / 点浮层外部）一律收起
    clearTimers();
    setOpen(false);
    setPinned(false);
  }, [clearTimers, pinned]);

  const handleCall = useCallback(() => {
    characterBridge()?.openCall();
    clearTimers();
    setOpen(false);
    setPinned(false);
  }, [clearTimers]);

  const syncEnabled = isRuntimeSyncEnabled(config);
  const syncHint = t("character.syncDisabled");
  const avatarPath = getCharacterAvatar(CHARACTER_NAME) ?? "";

  return (
    <Popover.Root open={open} onOpenChange={handleOpenChange}>
      <Popover.Trigger
        asChild
        onPointerEnter={handleTriggerEnter}
        onPointerLeave={handleTriggerLeave}
      >
        <CharacterStatusPill
          avatarPath={avatarPath}
          name={t("character.name")}
          online={config.connected}
          onClick={handleTriggerClick}
        />
      </Popover.Trigger>

      <AnimatePresence>
        {open && (
          <Popover.Portal forceMount>
            <Popover.Content
              className="cy-character-card"
              side="bottom"
              align="start"
              sideOffset={10}
              collisionPadding={12}
              forceMount
              // 打开与关闭都不把焦点挪进浮层/触发器：悬停预览不该打断输入框里的输入
              onOpenAutoFocus={(event) => event.preventDefault()}
              onCloseAutoFocus={(event) => event.preventDefault()}
              asChild
            >
              <motion.div
                initial={reduceMotion ? false : { opacity: 0, scale: 0.96, y: -6 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.96, y: -6 }}
                transition={{ duration: reduceMotion ? 0 : 0.2, ease: "easeOut" }}
                onPointerEnter={cancelClose}
                onPointerLeave={scheduleClose}
              >
                <div className="cy-character-card__profile">
                  <span className="cy-character-card__avatar" aria-hidden="true">
                    <img src={avatarPath} alt="" draggable={false} />
                  </span>
                  <div className="cy-character-card__identity">
                    <strong className="cy-character-card__name">{t("character.name")}</strong>
                    <span className={`cy-character-card__presence${config.connected ? "" : " is-offline"}`}>
                      <i className="cy-character-card__presence-dot" aria-hidden="true" />
                      {config.connected ? t("character.online") : t("character.offline")}
                    </span>
                  </div>
                </div>

                <div className="cy-character-card__traits">
                  <TraitLine
                    iconSrc={syncEnabled ? STATUS_ICON[state.status] : ""}
                    text={syncEnabled ? t(STATUS_LABEL_KEY[state.status]) : syncHint}
                    disabled={!syncEnabled}
                  />
                  <TraitLine
                    iconSrc={syncEnabled ? FEELING_ICON[state.feeling] : ""}
                    text={syncEnabled ? t(FEELING_LABEL_KEY[state.feeling]) : syncHint}
                    disabled={!syncEnabled}
                  />
                </div>

                <div className="cy-character-card__divider" />

                <button type="button" className="cy-character-card__call" onClick={handleCall}>
                  <Phone size={15} strokeWidth={2} aria-hidden="true" />
                  {t("character.call")}
                </button>
              </motion.div>
            </Popover.Content>
          </Popover.Portal>
        )}
      </AnimatePresence>
    </Popover.Root>
  );
}
