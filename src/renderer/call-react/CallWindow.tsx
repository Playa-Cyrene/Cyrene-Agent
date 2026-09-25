import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { ArrowLeft, AudioLines, Mic, PhoneOff, Sparkles, X } from "lucide-react";
import { getCharacterAvatar } from "../react/character-avatars";
import { useCallSession } from "./useCallSession";

const AVATAR = getCharacterAvatar("昔涟") ?? "";

function formatDuration(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  const pad = (value: number) => String(value).padStart(2, "0");
  return hours > 0 ? `${pad(hours)}:${pad(minutes)}:${pad(rest)}` : `${pad(minutes)}:${pad(rest)}`;
}

function statusLabel(state: string, error: string): string {
  if (error) return error;
  switch (state) {
    case "LISTENING": return "正在聆听你说话";
    case "THINKING": return "正在想怎么回答…";
    case "SPEAKING": return "昔涟正在说话";
    case "ENDED": return "本次通话已结束";
    case "ERROR": return "通话连接遇到问题";
    default: return "正在连接…";
  }
}

export function CallWindow() {
  const { state, messages, elapsed, error, volume, submitTurn, hangup } = useCallSession();
  const [showConversation, setShowConversation] = useState(false);
  const conversationRef = useRef<HTMLDivElement>(null);
  const reduceMotion = useReducedMotion();
  const active = state === "LISTENING" || state === "THINKING" || state === "SPEAKING";

  useEffect(() => {
    const list = conversationRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [messages, showConversation]);

  return (
    <main className={`cy-call-window is-${state.toLowerCase()}`}>
      <header className="cy-call-window__titlebar">
        <div className="cy-call-window__brand"><Sparkles size={14} aria-hidden="true" /><span>昔涟 · 语音通话</span></div>
        <button type="button" className="cy-call-window__close" onClick={hangup} aria-label="结束通话"><X size={17} /></button>
      </header>

      <div className="cy-call-window__status" role="status" aria-live="polite">
        <i className={active ? "is-active" : ""} aria-hidden="true" />
        <span>{statusLabel(state, error)}</span>
      </div>

      <section className="cy-call-window__stage">
        <AnimatePresence mode="wait" initial={false}>
          {showConversation ? (
            <motion.section
              key="conversation"
              className="cy-call-window__conversation-view"
              aria-label="通话对话"
              initial={reduceMotion ? false : { opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -5 }}
              transition={{ duration: reduceMotion ? 0 : 0.18 }}
            >
              <div className="cy-call-window__conversation-heading">
                <span>这段对话</span>
                <button type="button" onClick={() => setShowConversation(false)}><ArrowLeft size={14} />回到通话</button>
              </div>
              <div className="cy-call-window__messages" role="log" aria-live="polite" ref={conversationRef}>
                {messages.length ? messages.map((message) => (
                  <article className={`cy-call-window__message is-${message.speaker}`} key={message.id}>
                    <span>{message.speaker === "user" ? "你" : "昔涟"}</span>
                    <p>{message.text}</p>
                  </article>
                )) : <p className="cy-call-window__empty">你们的对话会出现在这里</p>}
              </div>
            </motion.section>
          ) : (
            <motion.section
              key="avatar"
              className="cy-call-window__avatar-scene"
              aria-label="昔涟通话画面"
              initial={reduceMotion ? false : { opacity: 0, scale: 0.985 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.985 }}
              transition={{ duration: reduceMotion ? 0 : 0.2 }}
            >
              <div className="cy-call-window__presence"><i aria-hidden="true" />{active ? "正在陪你" : state === "ERROR" ? "连接异常" : "准备通话"}</div>
              <div className={`cy-call-window__avatar-wrap ${state === "SPEAKING" ? "is-speaking" : ""} ${state === "LISTENING" ? "is-listening" : ""}`}>
                <span className="cy-call-window__orbit cy-call-window__orbit--outer" aria-hidden="true" />
                <span className="cy-call-window__orbit cy-call-window__orbit--inner" aria-hidden="true" />
                <button type="button" className="cy-call-window__avatar" onClick={() => setShowConversation(true)} aria-label="查看通话对话">
                  {AVATAR && <img src={AVATAR} alt="昔涟" draggable={false} />}
                </button>
                <span className="cy-call-window__sparkle cy-call-window__sparkle--one" aria-hidden="true">✦</span>
                <span className="cy-call-window__sparkle cy-call-window__sparkle--two" aria-hidden="true">✧</span>
              </div>
              <h1>昔涟</h1>
              <p className="cy-call-window__hint">轻点头像，看看你们正在聊什么</p>
              <div className={`cy-call-window__waveform ${active ? "is-active" : ""}`} aria-label={`麦克风音量 ${Math.round(volume * 100)}%`}>
                <AudioLines size={17} aria-hidden="true" />
                <div>{Array.from({ length: 25 }, (_, index) => {
                  const base = 10 + ((index * 17 + 13) % 23);
                  const height = state === "LISTENING" ? Math.max(5, base * (0.5 + Math.min(volume * 9, 0.9))) : base;
                  return <i key={index} style={{ height: `${height}px`, animationDelay: `${(index % 8) * -0.13}s` }} />;
                })}</div>
                <AudioLines size={17} aria-hidden="true" />
              </div>
              <span className="cy-call-window__duration">{formatDuration(elapsed)}</span>
            </motion.section>
          )}
        </AnimatePresence>
      </section>

      <footer className="cy-call-window__footer">
        <div className="cy-call-window__mic-state"><span><Mic size={15} /></span><span>{state === "LISTENING" ? "麦克风已开启" : state === "SPEAKING" ? "正在播放语音" : "语音通话"}</span></div>
        <div className="cy-call-window__actions">
          <button type="button" className="cy-call-window__send" onClick={submitTurn} disabled={state !== "LISTENING"} title="提前发送这一轮语音">发送</button>
          <button type="button" className="cy-call-window__hangup" onClick={hangup} aria-label="挂断通话" title="挂断通话"><PhoneOff size={18} /></button>
        </div>
      </footer>
    </main>
  );
}
