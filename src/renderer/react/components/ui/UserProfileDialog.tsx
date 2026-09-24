import { useEffect, useState } from "react";
import { format, isValid, parseISO } from "date-fns";
import { zhCN } from "date-fns/locale";
import { CalendarDays, ChevronLeft, ChevronRight, ImagePlus, LoaderCircle, X } from "lucide-react";
import { DayPicker } from "react-day-picker";
import { Dialog, Popover } from "radix-ui";
import { FALLBACK_TIMEZONE, normalizeTimezoneOptionValue, TIMEZONE_OPTIONS } from "../../../settings/timezone-options";
import { useTranslation } from "../../i18n";
import "react-day-picker/style.css";
import "./UserProfileDialog.css";

type Gender = "secret" | "male" | "female";

interface UserProfile {
  nickname: string;
  gender: Gender;
  callPreference: string;
  birthday: string;
  defaultCity: string;
  timezone: string;
}

interface UserApi {
  getProfile?: () => Promise<Partial<UserProfile> | null>;
  getAvatar?: () => Promise<string | null>;
  saveProfile?: (profile: UserProfile) => Promise<unknown>;
  uploadAvatar?: () => Promise<{ avatarPath?: string } | null>;
}

interface UserProfileDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  avatarUrl: string | null;
}

const EMPTY_PROFILE: UserProfile = {
  nickname: "",
  gender: "secret",
  callPreference: "",
  birthday: "",
  defaultCity: "",
  timezone: FALLBACK_TIMEZONE,
};

function getUserApi(): UserApi | undefined {
  return (window as typeof window & { user?: UserApi }).user;
}

function parseBirthday(value: string): Date | undefined {
  if (!value) return undefined;
  const date = parseISO(value);
  return isValid(date) ? date : undefined;
}

export function UserProfileDialog({ open, onOpenChange, avatarUrl }: UserProfileDialogProps) {
  const { t } = useTranslation();
  const [profile, setProfile] = useState<UserProfile>(EMPTY_PROFILE);
  const [currentAvatar, setCurrentAvatar] = useState<string | null>(avatarUrl);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    setCurrentAvatar(avatarUrl);
  }, [avatarUrl]);

  useEffect(() => {
    if (!open) return;
    let active = true;
    setLoading(true);
    setError("");
    const api = getUserApi();
    void Promise.all([api?.getProfile?.(), api?.getAvatar?.()])
      .then(([loadedProfile, loadedAvatar]) => {
        if (!active) return;
        setProfile({
          ...EMPTY_PROFILE,
          ...loadedProfile,
          gender: loadedProfile?.gender === "male" || loadedProfile?.gender === "female" ? loadedProfile.gender : "secret",
          timezone: normalizeTimezoneOptionValue(loadedProfile?.timezone),
        });
        setCurrentAvatar(loadedAvatar ?? avatarUrl);
      })
      .catch(() => { if (active) setError(t("ui.profile.loadFailed")); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [open, avatarUrl, t]);

  function updateProfile<K extends keyof UserProfile>(field: K, value: UserProfile[K]) {
    setProfile((current) => ({ ...current, [field]: value }));
  }

  async function saveProfile() {
    const api = getUserApi();
    if (!api?.saveProfile) return;
    setSaving(true);
    setError("");
    try {
      await api.saveProfile({
        ...profile,
        nickname: profile.nickname.trim(),
        callPreference: profile.callPreference.trim(),
        defaultCity: profile.defaultCity.trim(),
        timezone: normalizeTimezoneOptionValue(profile.timezone),
      });
      onOpenChange(false);
    } catch {
      setError(t("ui.profile.saveFailed"));
    } finally {
      setSaving(false);
    }
  }

  async function uploadAvatar() {
    const api = getUserApi();
    if (!api?.uploadAvatar) return;
    setUploading(true);
    setError("");
    try {
      const result = await api.uploadAvatar();
      if (result?.avatarPath) {
        setCurrentAvatar((await api.getAvatar?.()) ?? avatarUrl);
      }
    } catch {
      setError(t("ui.profile.uploadFailed"));
    } finally {
      setUploading(false);
    }
  }

  const birthday = parseBirthday(profile.birthday);

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="cy-user-profile__overlay" />
        <Dialog.Content className="cy-user-profile__dialog" aria-describedby="cy-user-profile-description">
          <header className="cy-user-profile__header">
            <div>
              <Dialog.Title className="cy-user-profile__title">{t("ui.profile.title")}</Dialog.Title>
              <Dialog.Description id="cy-user-profile-description" className="cy-user-profile__description">
                {t("ui.profile.description")}
              </Dialog.Description>
            </div>
            <Dialog.Close className="cy-user-profile__close" aria-label={t("common.close")}>
              <X size={17} aria-hidden="true" />
            </Dialog.Close>
          </header>

          <div className="cy-user-profile__body">
            <section className="cy-user-profile__avatar-row" aria-label={t("ui.profile.avatar")}>
              <div className="cy-user-profile__avatar">
                {currentAvatar
                  ? <img src={currentAvatar} alt={t("ui.userAlt")} />
                  : <span>{profile.nickname.trim().slice(0, 1) || "U"}</span>}
              </div>
              <div className="cy-user-profile__avatar-copy">
                <strong>{t("ui.profile.avatar")}</strong>
                <span>{t("ui.profile.avatarHint")}</span>
              </div>
              <button type="button" className="cy-user-profile__secondary-button" onClick={() => void uploadAvatar()} disabled={uploading}>
                {uploading ? <LoaderCircle size={15} className="cy-user-profile__spin" /> : <ImagePlus size={15} />}
                {t("ui.profile.uploadAvatar")}
              </button>
            </section>

            <div className="cy-user-profile__fields" aria-busy={loading}>
              <label className="cy-user-profile__field">
                <span>{t("ui.profile.nickname")}</span>
                <input name="nickname" value={profile.nickname} maxLength={40} autoComplete="nickname" onChange={(event) => updateProfile("nickname", event.target.value)} />
              </label>

              <fieldset className="cy-user-profile__field cy-user-profile__gender-field">
                <legend>{t("ui.profile.gender")}</legend>
                <div className="cy-user-profile__segmented" role="group" aria-label={t("ui.profile.gender")}>
                  {(["secret", "male", "female"] as const).map((gender) => (
                    <button
                      key={gender}
                      type="button"
                      aria-pressed={profile.gender === gender}
                      className={profile.gender === gender ? "is-selected" : ""}
                      onClick={() => updateProfile("gender", gender)}
                    >
                      {t(`ui.profile.gender${gender === "secret" ? "Secret" : gender === "male" ? "Male" : "Female"}`)}
                    </button>
                  ))}
                </div>
              </fieldset>

              <label className="cy-user-profile__field">
                <span>{t("ui.profile.callPreference")}</span>
                <input name="callPreference" value={profile.callPreference} maxLength={40} onChange={(event) => updateProfile("callPreference", event.target.value)} placeholder={t("ui.profile.callPreferencePlaceholder")} />
              </label>

              <div className="cy-user-profile__field">
                <span>{t("ui.profile.birthday")}</span>
                <Popover.Root>
                  <Popover.Trigger asChild>
                    <button type="button" className="cy-user-profile__date-trigger" data-testid="birthday-picker" aria-label={t("ui.profile.birthdayPlaceholder")}>
                      <CalendarDays size={16} aria-hidden="true" />
                      <span>{birthday ? format(birthday, "yyyy年M月d日", { locale: zhCN }) : t("ui.profile.birthdayPlaceholder")}</span>
                    </button>
                  </Popover.Trigger>
                  <Popover.Portal>
                    <Popover.Content className="cy-user-profile__calendar-popover" align="start" sideOffset={8} collisionPadding={12}>
                      <DayPicker
                        mode="single"
                        locale={zhCN}
                        selected={birthday}
                        onSelect={(date) => updateProfile("birthday", date ? format(date, "yyyy-MM-dd") : "")}
                        captionLayout="dropdown"
                        startMonth={new Date(1900, 0)}
                        endMonth={new Date()}
                        defaultMonth={birthday ?? new Date(2000, 0)}
                        showOutsideDays
                        labels={{
                          labelNext: () => t("ui.profile.nextMonth"),
                          labelPrevious: () => t("ui.profile.previousMonth"),
                          labelMonthDropdown: () => t("ui.profile.chooseMonth"),
                          labelYearDropdown: () => t("ui.profile.chooseYear"),
                        }}
                        components={{
                          Chevron: ({ orientation }) => orientation === "left"
                            ? <ChevronLeft size={16} aria-hidden="true" />
                            : <ChevronRight size={16} aria-hidden="true" />,
                        }}
                      />
                    </Popover.Content>
                  </Popover.Portal>
                </Popover.Root>
              </div>

              <label className="cy-user-profile__field">
                <span>{t("ui.profile.defaultCity")}</span>
                <input name="defaultCity" value={profile.defaultCity} maxLength={80} onChange={(event) => updateProfile("defaultCity", event.target.value)} placeholder={t("ui.profile.defaultCityPlaceholder")} />
              </label>

              <label className="cy-user-profile__field">
                <span>{t("ui.profile.timezone")}</span>
                <select name="timezone" value={profile.timezone} onChange={(event) => updateProfile("timezone", normalizeTimezoneOptionValue(event.target.value))}>
                  {TIMEZONE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
              </label>
            </div>
            {error && <p className="cy-user-profile__error" role="alert">{error}</p>}
          </div>

          <footer className="cy-user-profile__footer">
            <button type="button" className="cy-user-profile__secondary-button" onClick={() => onOpenChange(false)} disabled={saving}>
              {t("common.cancel")}
            </button>
            <button type="button" className="cy-user-profile__primary-button" onClick={() => void saveProfile()} disabled={loading || saving}>
              {saving && <LoaderCircle size={15} className="cy-user-profile__spin" />}
              {saving ? t("ui.profile.saving") : t("ui.profile.save")}
            </button>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
