import type { ScheduleConfig } from "../../../settings/scheduler/types";

export interface ScheduledTaskTemplate {
  id: "dailyBriefing" | "codeReview" | "weeklyReview";
  mode: "work" | "code";
  schedule: Extract<ScheduleConfig, { kind: "daily" | "weekly" }>;
  titleKey: string;
  descriptionKey: string;
  promptKey: string;
}

export interface ScheduledTaskTemplateDraft {
  title: string;
  description: string;
  prompt: string;
  mode: ScheduledTaskTemplate["mode"];
  schedule: ScheduledTaskTemplate["schedule"];
}

export const scheduledTaskTemplates: readonly ScheduledTaskTemplate[] = [
  {
    id: "dailyBriefing",
    mode: "work",
    schedule: { kind: "daily", timeOfDay: "09:00" },
    titleKey: "scheduler.templates.dailyBriefing.title",
    descriptionKey: "scheduler.templates.dailyBriefing.description",
    promptKey: "scheduler.templates.dailyBriefing.prompt",
  },
  {
    id: "codeReview",
    mode: "code",
    schedule: { kind: "daily", timeOfDay: "18:00" },
    titleKey: "scheduler.templates.codeReview.title",
    descriptionKey: "scheduler.templates.codeReview.description",
    promptKey: "scheduler.templates.codeReview.prompt",
  },
  {
    id: "weeklyReview",
    mode: "work",
    schedule: { kind: "weekly", dayOfWeek: 5, timeOfDay: "17:00" },
    titleKey: "scheduler.templates.weeklyReview.title",
    descriptionKey: "scheduler.templates.weeklyReview.description",
    promptKey: "scheduler.templates.weeklyReview.prompt",
  },
];

export function materializeScheduledTaskTemplate(
  template: ScheduledTaskTemplate,
  translate: (key: string) => string,
): ScheduledTaskTemplateDraft {
  return {
    title: translate(template.titleKey),
    description: translate(template.descriptionKey),
    prompt: translate(template.promptKey),
    mode: template.mode,
    schedule: { ...template.schedule },
  };
}
