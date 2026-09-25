import type { ComponentPropsWithRef } from "react";
import { useTranslation } from "../../i18n";
import "./CharacterStatusPill.css";

interface CharacterStatusPillProps extends Omit<ComponentPropsWithRef<"button">, "children"> {
  /** 角色头像资源 */
  avatarPath: string;
  /** 角色名，仅用于无障碍标签 */
  name: string;
  /** 是否在线：决定右下角状态点的配色 */
  online: boolean;
}

/**
 * 昔涟头像触发器：头像 + 右下角在线点，点击/悬停由外层的角色信息浮层接管。
 * 额外 props（含 Popover 注入的展开态与事件）全部透传到 button 上。
 */
export function CharacterStatusPill({ avatarPath, name, online, className, ...rest }: CharacterStatusPillProps) {
  const { t } = useTranslation();
  const classes = ["cy-character-pill", online ? "is-online" : "", className].filter(Boolean).join(" ");

  return (
    <button type="button" className={classes} aria-label={t("character.openInfo", { name })} {...rest}>
      <img className="cy-character-pill__avatar" src={avatarPath} alt="" draggable={false} />
      <i className="cy-character-pill__presence" aria-hidden="true" />
    </button>
  );
}
