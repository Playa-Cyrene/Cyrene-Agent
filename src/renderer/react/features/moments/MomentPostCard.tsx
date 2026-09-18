import { CommentOutlined, DeleteOutlined, HeartFilled, HeartOutlined } from "@ant-design/icons";
import { useMemo, useState, type ReactNode } from "react";
import {
  MOMENT_MAX_COMMENT_TEXT_LENGTH,
  buildMomentMediaUrl,
  type MomentAuthor,
  type MomentCreateCommentInput,
  type MomentFeedItem,
} from "../../../../shared/moments-types";
import { resolveAsset } from "../../../../shared/renderer-base";
import { useTranslation } from "../../i18n";
import { useFeedback } from "../../components/feedback/FeedbackProvider";
import { formatMomentTime } from "./moments-utils";

const CYRENE_AVATAR_URL = resolveAsset("avatars/cyrene-avatar.png");

/**
 * 正文按 @昵称 切片：点名片段高亮显示（QQ 群的蓝色 @ 手感）。
 * 昵称来自 post.mentions（主进程白名单），文本里的其他 @ 不着色。
 */
function renderPostText(text: string, mentions: readonly string[] | undefined, cyreneLabel: string) {
  if (!mentions || mentions.length === 0) return text;
  const displayNames = mentions.map((name) => (name === "cyrene" ? cyreneLabel : name));
  // 找出每个 @昵称 在文本中的位置，按出现顺序切片
  const marks: Array<{ start: number; end: number }> = [];
  for (const display of displayNames) {
    let cursor = 0;
    for (;;) {
      const at = text.indexOf(`@${display}`, cursor);
      if (at < 0) break;
      marks.push({ start: at, end: at + display.length + 1 });
      cursor = at + display.length + 1;
    }
  }
  if (marks.length === 0) return text;
  marks.sort((a, b) => a.start - b.start);
  const nodes: ReactNode[] = [];
  let pos = 0;
  for (const mark of marks) {
    if (mark.start < pos) continue; // 重叠片段跳过
    if (mark.start > pos) nodes.push(text.slice(pos, mark.start));
    nodes.push(
      <span key={`${mark.start}-${mark.end}`} className="moment-card__mention">
        {text.slice(mark.start, mark.end)}
      </span>,
    );
    pos = mark.end;
  }
  if (pos < text.length) nodes.push(text.slice(pos));
  return nodes;
}

interface MomentPostCardProps {
  item: MomentFeedItem;
  userAvatarUrl: string | null;
  userDisplayName: string;
  onToggleLike: (postId: string) => void;
  onDelete: (postId: string) => void;
  /** 返回 null 表示成功；返回字符串为错误提示 */
  onComment: (input: MomentCreateCommentInput) => Promise<string | null>;
}

/** 微信朋友圈式动态卡片：头像 + 名字 + 正文 + 九宫格图 + 时间/操作 + 点赞评论。 */
export function MomentPostCard({
  item,
  userAvatarUrl,
  userDisplayName,
  onToggleLike,
  onDelete,
  onComment,
}: MomentPostCardProps) {
  const { t } = useTranslation();
  // 统一反馈入口：删除动态走危险确认
  const feedback = useFeedback();
  const { post, comments, likes } = item;
  const [commenting, setCommenting] = useState(false);
  const [draft, setDraft] = useState("");
  const [replyTo, setReplyTo] = useState<string | undefined>(undefined);
  const [commentError, setCommentError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  // 作者显示名：昔涟/用户走既定名，其余一律按角色人设昵称原样显示
  const authorName = (author: MomentAuthor): string =>
    author === "cyrene" ? t("moments.cyreneName") : author === "user" ? userDisplayName : author;
  const isCharacterAuthor = (author: MomentAuthor): boolean => author !== "user" && author !== "cyrene";

  const likedByUser = likes.some((like) => like.actor === "user");
  // 点赞行只展示真实落库的点赞（角色/昔涟的延迟点赞到达后经广播刷新出现）
  const likeNames = likes.map((like) => authorName(like.actor));
  const commentsById = useMemo(() => new Map(comments.map((comment) => [comment.id, comment])), [comments]);
  const replyTarget = replyTo ? commentsById.get(replyTo) : undefined;

  const imageClass = post.media.length === 1
    ? "moment-card__images moment-card__images--single"
    : post.media.length === 2 || post.media.length === 4
      ? "moment-card__images moment-card__images--two"
      : "moment-card__images";

  function startReply(commentId?: string) {
    setReplyTo(commentId);
    setCommenting(true);
    setCommentError(null);
  }

  async function handleSend() {
    const content = draft.trim();
    if (!content || sending) return;
    setSending(true);
    const failure = await onComment({ postId: post.id, content, replyTo });
    setSending(false);
    if (failure) {
      setCommentError(failure);
      return;
    }
    setDraft("");
    setReplyTo(undefined);
    setCommenting(false);
    setCommentError(null);
  }

  return (
    // id 作为通知跳转的滚动锚点：点击通知列表里的条目可定位到对应动态
    <article className="moment-card" id={`moment-post-${post.id}`}>
      <div className="moment-card__avatar">
        {post.author === "cyrene" ? (
          <img src={CYRENE_AVATAR_URL} alt={t("moments.cyreneName")} draggable={false} />
        ) : userAvatarUrl ? (
          <img src={userAvatarUrl} alt={userDisplayName} draggable={false} />
        ) : (
          <span className="moment-card__avatar-fallback">{userDisplayName.slice(0, 1)}</span>
        )}
      </div>

      <div className="moment-card__body">
        <div className="moment-card__name">{authorName(post.author)}</div>
        {post.title && <div className="moment-card__title">{post.title}</div>}
        {post.text && (
          <div className="moment-card__text">{renderPostText(post.text, post.mentions, t("moments.cyreneName"))}</div>
        )}

        {post.media.length > 0 && (
          <div className={imageClass}>
            {post.media.map((media) => (
              <img
                key={media.id}
                src={media.origin !== "character_asset"
                  ? buildMomentMediaUrl(post.id, media.ref)
                  : media.ref.startsWith("local-sticker:")
                    ? media.ref
                    : resolveAsset(media.ref)}
                draggable={false}
              />
            ))}
          </div>
        )}

        <div className="moment-card__meta">
          <span className="moment-card__time">{formatMomentTime(post.createdAt, Date.now())}</span>
          <button
            type="button"
            className="moment-card__delete"
            onClick={async () => {
              // 删除动态不可恢复：危险确认，默认聚焦取消，确认后才触发删除
              const confirmed = await feedback.confirm({
                title: t("moments.delete"),
                message: t("moments.confirmDelete"),
                confirmText: t("moments.delete"),
                cancelText: t("moments.cancel"),
                dangerous: true,
              });
              if (confirmed) onDelete(post.id);
            }}
          >
            <DeleteOutlined />
            {t("moments.delete")}
          </button>
          <div className="moment-card__actions">
            <button
              type="button"
              className={`moment-card__action${likedByUser ? " is-active" : ""}`}
              onClick={() => onToggleLike(post.id)}
            >
              {likedByUser ? <HeartFilled /> : <HeartOutlined />}
              {t("moments.like")}
              {likeNames.length > 0 && <span className="moment-card__action-count">{likeNames.length}</span>}
            </button>
            <button
              type="button"
              className="moment-card__action"
              onClick={() => startReply(undefined)}
            >
              <CommentOutlined />
              {t("moments.comment")}
              {comments.length > 0 && <span className="moment-card__action-count">{comments.length}</span>}
            </button>
          </div>
        </div>

        {(likeNames.length > 0 || comments.length > 0 || commenting) && (
          <div className="moment-card__interactions">
            {likeNames.length > 0 && (
              <div className="moment-card__likes">
                <HeartFilled className="moment-card__likes-icon" />
                {likeNames.join("、")}
              </div>
            )}

            {comments.map((comment) => {
              const target = comment.replyTo ? commentsById.get(comment.replyTo) : undefined;
              return (
                <button
                  type="button"
                  key={comment.id}
                  className="moment-card__comment"
                  id={`moment-comment-${comment.id}`}
                  onClick={() => startReply(comment.id)}
                >
                  <span className="moment-card__comment-main">
                    <span
                      className={`moment-card__comment-name${
                        isCharacterAuthor(comment.author) ? " moment-card__comment-name--character" : ""
                      }`}
                    >
                      {authorName(comment.author)}
                    </span>
                    {target && (
                      <>
                        <span className="moment-card__comment-reply">{t("moments.replyPrefix")}</span>
                        <span className="moment-card__comment-name">{authorName(target.author)}</span>
                      </>
                    )}
                    <span className="moment-card__comment-colon">：</span>
                    <span className="moment-card__comment-content">{comment.content}</span>
                  </span>
                </button>
              );
            })}

            {commenting && (
              <div className="moment-card__comment-editor">
                <input
                  autoFocus
                  type="text"
                  value={draft}
                  maxLength={MOMENT_MAX_COMMENT_TEXT_LENGTH}
                  placeholder={
                    replyTarget
                      ? t("moments.replyPlaceholder", { name: authorName(replyTarget.author) })
                      : t("moments.commentPlaceholder")
                  }
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void handleSend();
                    if (event.key === "Escape") setCommenting(false);
                  }}
                />
                <button
                  type="button"
                  className="moment-card__comment-send"
                  disabled={!draft.trim() || sending}
                  onClick={() => void handleSend()}
                >
                  {t("moments.send")}
                </button>
                <button
                  type="button"
                  className="moment-card__comment-cancel"
                  onClick={() => setCommenting(false)}
                >
                  {t("moments.cancel")}
                </button>
              </div>
            )}
            {commentError && <div className="moment-card__comment-error">{commentError}</div>}
          </div>
        )}
      </div>
    </article>
  );
}
