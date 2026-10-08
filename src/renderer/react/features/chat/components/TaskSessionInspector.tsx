import { useEffect, useMemo, useState } from "react";
import { ChatMessageList } from "./ChatMessageList";
import { useTranslation } from "../../../i18n";
import { chatStore } from "../pages/chat-page-bridge";
import { getCharacterStatusMoodSet, getCharacterStatusMoodUrl, type CharacterStatusMood } from "../../../character-status-moods";
import type { TaskSession } from "../../../../../shared/task-session";
import { useCyreneAvatar } from "../../../hooks/useCyreneAvatar";
import { toTaskChatMessages } from "./task-session-presentation";
import "./TaskSessionInspector.css";

function taskMood(session: TaskSession | null): CharacterStatusMood {
  if (!session) return "连接中";
  if (session.status === "completed") return "已处理";
  if (session.status === "failed" || session.status === "cancelled" || session.status === "interrupted") return "已中断";

  const currentActivity = [...session.trace].reverse().find((record) =>
    record.kind === "progress"
    || (record.kind === "tool" && record.phase === "start")
    || (record.kind === "reasoning" && (record.phase === "start" || record.phase === "delta"))
    || (record.kind === "round" && record.phase === "start"),
  );
  return currentActivity?.kind === "tool" || currentActivity?.kind === "progress" ? "工作中" : "思考中";
}

export function TaskSessionInspector({
  taskId,
  parentConversationId,
  description,
  nickname,
  assetFileName,
  preferredAddress,
  active,
}: {
  taskId: string;
  parentConversationId: string;
  description: string;
  nickname: string;
  assetFileName: string;
  preferredAddress: string;
  active: boolean;
}) {
  const { t } = useTranslation();
  const cyreneAvatarUrl = useCyreneAvatar();
  const [session, setSession] = useState<TaskSession | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const messages = useMemo(() => session ? toTaskChatMessages(session) : [], [session]);

  useEffect(() => {
    if (!active) {
      setSession(null);
      return;
    }
    let mounted = true;
    let timer: number | undefined;
    const refresh = async () => {
      try {
        const result = await chatStore()?.getTaskSession(taskId, parentConversationId);
        if (!mounted) return;
        setSession((current) => current?.updatedAt === result?.updatedAt ? current : result ?? null);
        setLoadFailed(false);
        if (result?.status === "running") timer = window.setTimeout(() => void refresh(), 600);
      } catch {
        if (!mounted) return;
        setLoadFailed(true);
        timer = window.setTimeout(() => void refresh(), 1500);
      }
    };
    void refresh();
    return () => {
      mounted = false;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [active, parentConversationId, taskId]);

  const status = session?.status ?? "running";
  const statusLabel = status === "running"
    ? t("taskDelegation.statusRunning")
    : status === "completed"
      ? t("taskDelegation.statusCompleted")
      : status === "cancelled"
        ? t("taskDelegation.statusCancelled")
        : status === "failed"
          ? t("taskDelegation.statusFailed")
          : t("taskDelegation.statusInterrupted");
  const mood = taskMood(session);
  const moodUrl = getCharacterStatusMoodUrl(assetFileName, mood);
  const moodAssets = useMemo(() => getCharacterStatusMoodSet(assetFileName), [assetFileName]);
  const assistantAvatar = useMemo(
    () => moodUrl ? { src: moodUrl, alt: nickname, sprite: true } : undefined,
    [moodUrl, nickname],
  );

  return (
    <section className="cy-task-session-inspector">
      <header className="cy-task-session-inspector__header">
        <div className="cy-task-session-inspector__title">{description}</div>
        <div className="cy-task-session-inspector__header-status">
          <div className={`cy-task-session-inspector__status is-${status}`}>{statusLabel}</div>
          {session?.companionId && (
            <div className={`cy-task-session-inspector__context${session.contextOpen === false ? " is-closed" : " is-open"}`}>
              {t(session.contextOpen === false ? "taskDelegation.contextClosed" : "taskDelegation.contextOpen")}
            </div>
          )}
        </div>
      </header>
      {loadFailed && <div className="cy-task-session-inspector__message">{t("taskDelegation.loadFailed")}</div>}
      {!session && !loadFailed && (
        <div className="cy-task-session-inspector__message cy-task-session-inspector__message--with-avatar">
          {moodUrl && <img className="cy-task-session-inspector__loading-avatar" src={moodUrl} alt={nickname} draggable={false} />}
          <span>{t("taskDelegation.loading")}</span>
        </div>
      )}
      {session && (
        <ChatMessageList
          messages={messages}
          conversationId={session.id}
          mode={session.mode}
          preferredAddress={preferredAddress}
          characterMoodAssets={moodAssets}
          assistantAvatar={assistantAvatar}
          userAvatar={{ src: cyreneAvatarUrl, alt: t("messageList.cyreneAvatarAlt") }}
          revisionBusy
          workspaceRoot={session.resolvedWorkspaceRoot}
        />
      )}
    </section>
  );
}
