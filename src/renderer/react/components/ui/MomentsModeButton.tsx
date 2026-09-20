import React, { useEffect, useState } from "react";
import momentsIconUrl from "../../assets/moments.png?url";
import { useTranslation } from "../../i18n";
import type { MomentFeedItem } from "../../../../shared/moments-types";
import {
  countUnreadMomentNotices,
  deriveMomentNotices,
  getMomentsLastReadAt,
  subscribeMomentsWaterMark,
} from "../../features/moments/moments-utils";

interface MomentsModeButtonProps {
  active?: boolean;
  onClick?: () => void;
}

/** 「动态」导航按钮：常驻侧栏，自己拉取 feed 派生未读数，红点随互动到达与已读水位同步。 */
export function MomentsModeButton({ active = false, onClick }: MomentsModeButtonProps) {
  const { t } = useTranslation();
  const [unreadCount, setUnreadCount] = useState(0);

  useEffect(() => {
    const api = window.moments;
    if (!api) return;

    let disposed = false;
    // 未读 = 水位之后的互动数，两侧输入（feed 数据、已读水位）任一变化都要重算
    async function refresh() {
      // 函数声明内 TS 不保留外层判空，防御性再判一次
      if (!api) return;
      try {
        const items: MomentFeedItem[] = await api.list({ limit: 50 });
        if (disposed) return;
        setUnreadCount(countUnreadMomentNotices(deriveMomentNotices(items), getMomentsLastReadAt()));
      } catch {
        // 拉取失败保持现有徽标，下次数据变更广播时自然重试
      }
    }

    // 数据变化（新点赞/评论到达）与已读水位推进（通知面板被打开）都会改变未读数
    const unsubscribeChanged = api.onChanged(() => void refresh());
    const unsubscribeWaterMark = subscribeMomentsWaterMark(() => void refresh());
    void refresh();

    return () => {
      disposed = true;
      unsubscribeChanged();
      unsubscribeWaterMark();
    };
  }, []);

  return <button className={`cy-side-action ${active ? "is-active" : ""}`} onClick={onClick} type="button" title={t("ui.moments")} aria-pressed={active}>
    <span className="cy-side-action-icon">
      <img src={momentsIconUrl} alt="" width="22" height="22" style={{ objectFit: "contain" }} />
      {unreadCount > 0 && <span className="cy-side-action-dot" aria-hidden="true" />}
    </span>
    <span className="cy-side-action-label">{t("ui.moments")}</span>
  </button>;
}
