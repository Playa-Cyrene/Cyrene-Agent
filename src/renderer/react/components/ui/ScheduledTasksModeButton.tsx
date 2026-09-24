import { Clock3 } from "lucide-react";
import { useTranslation } from "../../i18n";

interface ScheduledTasksModeButtonProps {
  active?: boolean;
  onClick?: () => void;
}

export function ScheduledTasksModeButton({ active = false, onClick }: ScheduledTasksModeButtonProps) {
  const { t } = useTranslation();
  return (
    <button className={`cy-side-action ${active ? "is-active" : ""}`} onClick={onClick} type="button" title={t("ui.scheduledTasks")} aria-pressed={active}>
      <span className="cy-side-action-icon"><Clock3 size={18} strokeWidth={1.8} /></span>
      <span className="cy-side-action-label">{t("ui.scheduledTasks")}</span>
    </button>
  );
}
