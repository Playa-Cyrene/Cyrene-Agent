import { useState } from "react";
import { useUserAvatar } from "../../hooks/useUserAvatar";
import { useUserNickname } from "../../hooks/useUserNickname";
import { useTranslation } from "../../i18n";
import { UserProfileDialog } from "./UserProfileDialog";
import "./UserAvatar.css";

interface UserAvatarProps {
  label?: string;
}

export function UserAvatar({ label }: UserAvatarProps) {
  const { t } = useTranslation();
  const avatarUrl = useUserAvatar();
  const nickname = useUserNickname();
  const [profileOpen, setProfileOpen] = useState(false);
  const displayLabel = (label ?? nickname) || "User";

  return (
    <>
      <button
        type="button"
        className="cy-user-avatar cy-user-avatar__trigger"
        aria-label={t("ui.openUserProfile")}
        onClick={() => setProfileOpen(true)}
      >
        <span className="cy-user-avatar-circle">
          {avatarUrl
            ? <img src={avatarUrl} alt={t("ui.userAlt")} draggable={false} />
            : <span>U</span>}
        </span>
        <span className="cy-user-avatar-label">{displayLabel}</span>
      </button>
      <UserProfileDialog open={profileOpen} onOpenChange={setProfileOpen} avatarUrl={avatarUrl} />
    </>
  );
}
