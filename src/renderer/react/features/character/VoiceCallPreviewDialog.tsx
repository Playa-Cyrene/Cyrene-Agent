import { useEffect, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Dialog } from "radix-ui";
import { ArrowLeft, AudioLines, MessageCircle, Mic, PhoneOff, Sparkles, X } from "lucide-react";
import { getCharacterAvatar } from "../../character-avatars";
import { useTranslation } from "../../i18n";
import "./VoiceCallPreviewDialog.css";

interface VoiceCallPreviewDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const CHARACTER_NAME = "昔涟";
const AVATAR_PATH = getCharacterAvatar(CHARACTER_NAME) ?? "";

const PREVIEW_MESSAGES = [
  { speaker: "you", text: "今天想一起做点什么？", time: "刚刚" },
  { speaker: "cyrene", text: "先陪你聊一会儿吧。今天过得怎么样？", time: "刚刚" },
  { speaker: "you", text: "还不错，有你在就很放松。", time: "刚刚" },
  { speaker: "cyrene", text: "那我就安静地陪着你，想说什么都可以。", time: "刚刚" },
] as const;

const WAVEFORM = [12, 19, 27, 17, 34, 22, 14, 28, 38, 23, 16, 31, 20, 13, 25, 35, 18, 11, 23, 30, 16, 27, 14, 20, 33, 18, 12];

export function VoiceCallPreviewDialog({ open, onOpenChange }: VoiceCallPreviewDialogProps) {
  const { t } = useTranslation();
  const reduceMotion = useReducedMotion();
  const [showConversation, setShowConversation] = useState(false);

  useEffect(() => {
    if (open) setShowConversation(false);
  }, [open]);

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="cy-call-preview__overlay" />
        <Dialog.Content className="cy-call-preview__dialog" aria-describedby="cy-call-preview-description">
          <header className="cy-call-preview__header">
            <div className="cy-call-preview__heading-icon" aria-hidden="true"><Sparkles size={15} /></div>
            <div className="cy-call-preview__heading-copy">
              <Dialog.Title className="cy-call-preview__title">{t("character.previewTitle")}</Dialog.Title>
              <Dialog.Description id="cy-call-preview-description" className="cy-call-preview__description">
                {t("character.previewDescription")}
              </Dialog.Description>
            </div>
            <Dialog.Close className="cy-call-preview__close" aria-label={t("common.close")}>
              <X size={17} aria-hidden="true" />
            </Dialog.Close>
          </header>

          <div className="cy-call-preview__stage">
            <AnimatePresence mode="wait" initial={false}>
              {showConversation ? (
                <motion.section
                  key="conversation"
                  className="cy-call-preview__conversation-view"
                  aria-label={t("character.previewConversation")}
                  initial={reduceMotion ? false : { opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -5 }}
                  transition={{ duration: reduceMotion ? 0 : 0.18 }}
                >
                  <div className="cy-call-preview__conversation-heading">
                    <span>{t("character.previewConversation")}</span>
                    <button type="button" className="cy-call-preview__back" onClick={() => setShowConversation(false)}>
                      <ArrowLeft size={13} aria-hidden="true" />
                      {t("character.previewBackToCall")}
                    </button>
                  </div>
                  <div className="cy-call-preview__conversation" role="log" aria-live="polite">
                    {PREVIEW_MESSAGES.map((message, index) => (
                      <div className={`cy-call-preview__message is-${message.speaker}`} key={`${message.speaker}-${index}`}>
                        <span className="cy-call-preview__message-speaker">
                          {message.speaker === "you" ? t("character.previewYou") : t("character.name")}
                        </span>
                        <p>{message.text}</p>
                        <time>{message.time}</time>
                      </div>
                    ))}
                  </div>
                  <p className="cy-call-preview__conversation-note">
                    <MessageCircle size={14} aria-hidden="true" />
                    {t("character.previewConversationHint")}
                  </p>
                </motion.section>
              ) : (
                <motion.section
                  key="avatar"
                  className="cy-call-preview__avatar-scene"
                  aria-label={t("character.previewAvatarScene")}
                  initial={reduceMotion ? false : { opacity: 0, scale: 0.98 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.98 }}
                  transition={{ duration: reduceMotion ? 0 : 0.2 }}
                >
                  <div className="cy-call-preview__presence">
                    <i aria-hidden="true" />
                    {t("character.status.companion")}
                  </div>
                  <div className="cy-call-preview__avatar-wrap">
                    <span className="cy-call-preview__orbit cy-call-preview__orbit--outer" aria-hidden="true" />
                    <span className="cy-call-preview__orbit cy-call-preview__orbit--inner" aria-hidden="true" />
                    <button
                      className="cy-call-preview__avatar-toggle"
                      type="button"
                      aria-label={t("character.previewOpenConversation")}
                      onClick={() => setShowConversation(true)}
                    >
                      <img src={AVATAR_PATH} alt={t("character.name")} draggable={false} />
                    </button>
                    <span className="cy-call-preview__sparkle cy-call-preview__sparkle--one" aria-hidden="true">✦</span>
                    <span className="cy-call-preview__sparkle cy-call-preview__sparkle--two" aria-hidden="true">✧</span>
                  </div>
                  <h2 className="cy-call-preview__character-name">{t("character.name")}</h2>
                  <p className="cy-call-preview__avatar-hint">{t("character.previewAvatarHint")}</p>
                  <div className="cy-call-preview__waveform" aria-hidden="true">
                    <AudioLines size={17} strokeWidth={1.7} />
                    <div className="cy-call-preview__waveform-bars">
                      {WAVEFORM.map((height, index) => (
                        <i key={index} style={{ height: `${height}px`, animationDelay: `${(index % 8) * -0.13}s` }} />
                      ))}
                    </div>
                    <AudioLines size={17} strokeWidth={1.7} />
                  </div>
                  <span className="cy-call-preview__waveform-label">{t("character.previewListening")}</span>
                </motion.section>
              )}
            </AnimatePresence>
          </div>

          <footer className="cy-call-preview__footer">
            <div className="cy-call-preview__mic-state">
              <span className="cy-call-preview__mic-icon"><Mic size={16} aria-hidden="true" /></span>
              <span>{t("character.previewMicOff")}</span>
            </div>
            <button type="button" className="cy-call-preview__end-preview" onClick={() => onOpenChange(false)}>
              <PhoneOff size={16} aria-hidden="true" />
              {t("character.previewClose")}
            </button>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
