/** Slash 菜单里可安全通过 IPC 暴露给渲染端的 Skill 信息。 */
export type SkillSuggestionMode = "work" | "code" | "learn";

export interface SkillSuggestionItem {
  id: string;
  name: string;
  description: string;
  source: "builtin" | "user";
}
