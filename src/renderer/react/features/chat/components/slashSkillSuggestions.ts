import type { SkillSuggestionItem } from "../../../../../shared/skill-suggestions";

export interface ActiveSlashSkillToken {
  start: number;
  end: number;
  query: string;
}

export type SlashSkillSuggestion = SkillSuggestionItem;

export function getActiveSlashSkillToken(
  value: string,
  selectionStart: number,
  selectionEnd: number,
): ActiveSlashSkillToken | null {
  if (selectionStart !== selectionEnd || value[0] !== "/") return null;

  const whitespaceIndex = value.search(/\s/);
  const end = whitespaceIndex === -1 ? value.length : whitespaceIndex;
  const query = value.slice(1, end);
  if (!/^[a-z0-9-]*$/i.test(query)) return null;
  if (selectionStart < 1 || selectionStart > end) return null;

  return { start: 0, end, query };
}

export function replaceActiveSlashSkillToken(
  value: string,
  token: ActiveSlashSkillToken,
  skillId: string,
): { value: string; cursor: number } {
  const suffix = value.slice(token.end);
  const separator = /^\s/.test(suffix) ? "" : " ";
  const nextValue = `${value.slice(0, token.start)}/${skillId}${separator}${suffix}`;
  return {
    value: nextValue,
    cursor: token.start + skillId.length + 2,
  };
}

export function filterSlashSkillSuggestions(
  skills: SlashSkillSuggestion[],
  query: string,
): SlashSkillSuggestion[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) return skills;

  return skills
    .map((skill, index) => {
      const id = skill.id.toLocaleLowerCase();
      const name = skill.name.toLocaleLowerCase();
      const description = skill.description.toLocaleLowerCase();
      const startsWithQuery = id.startsWith(normalizedQuery) || name.startsWith(normalizedQuery);
      const matches = startsWithQuery || id.includes(normalizedQuery)
        || name.includes(normalizedQuery) || description.includes(normalizedQuery);
      return { skill, index, startsWithQuery, matches };
    })
    .filter((entry) => entry.matches)
    .sort((left, right) => Number(right.startsWithQuery) - Number(left.startsWithQuery) || left.index - right.index)
    .map((entry) => entry.skill);
}
