import { describe, expect, it } from "vitest";
import { materializeScheduledTaskTemplate, scheduledTaskTemplates } from "./scheduledTaskTemplates";

describe("scheduled task templates", () => {
  it("ships reusable Work and Code task drafts", () => {
    expect(scheduledTaskTemplates.map((template) => template.mode)).toEqual(["work", "code", "work"]);
  });

  it("materializes a template as an unsaved draft with its schedule and prompt", () => {
    const template = scheduledTaskTemplates[1];
    const draft = materializeScheduledTaskTemplate(template, (key) => ({
      "scheduler.templates.codeReview.title": "Code review",
      "scheduler.templates.codeReview.description": "Review recent changes",
      "scheduler.templates.codeReview.prompt": "Inspect recent changes without modifying files.",
    }[key] ?? key));

    expect(draft).toMatchObject({
      title: "Code review",
      description: "Review recent changes",
      prompt: "Inspect recent changes without modifying files.",
      mode: "code",
      schedule: { kind: "daily", timeOfDay: "18:00" },
    });
  });
});
