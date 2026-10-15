// Skill 系统 —— 类型定义。
// id 永远 = 目录名（kebab-case），是唯一对外标识；name 仅展示，不参与匹配。

import type { ToolEffectKind } from "../orchestrator/tools/registry/tool-registry";

/** Skill 可用的会话模式。chat 模式不暴露 skill。 */
export type SkillMode = "work" | "code" | "learn";

/** 一个 skill 的完整内存表示。 */
export interface SkillEntry {
  id: string;            // = 目录名，kebab-case，唯一对外标识
  name: string;          // frontmatter.name，仅展示，不参与匹配
  description: string;   // 注入 prompt 清单用
  tools?: string[];      // 关联的 tool id
  version?: string;      // 语义版本，纯展示
  dirPath: string;       // skill 目录绝对路径
  bodyPath: string;      // SKILL.md 绝对路径
  references: string[];  // references/ 下文件名清单（不含内容）
  enabled: boolean;      // 运行时状态，持久化到 settings.json
  source: "builtin" | "user";  // 来源
  manifest?: SkillManifest;
  /** Skill 声明的工作流效果类型；加载指令本身只读，实际操作由各工具检查权限。 */
  effectKind?: ToolEffectKind;
  /** Skill 默认可用的会话模式白名单。未设置 = 全模式通用（向后兼容）。
   *  仅 work/code/learn 参与过滤；可被 SkillModeOverrides 覆盖。 */
  modes?: SkillMode[];
  /** 不在 UI 设置面板展示（如角色语气校准等系统级 skill）。 */
  hiddenFromUi?: boolean;
}

/** Skill-模式覆盖层：用户自定义每个 skill 在每个会话模式下的可见性。
 *  key = skillId，value = { mode: enabled }。
 *  运行时优先级：覆盖层 > SkillEntry.modes > 全模式可见。 */
export type SkillModeOverrides = Record<string, Partial<Record<SkillMode, boolean>>>;

export interface SkillManifest {
  id: string;
  version: string;
  defaultEnabled: boolean;
  entry: string;
  dependencies: string[];
  autoInject?: boolean;
  autoPlayPolicy?: string;
  /** Task Router 快捷路径命中时使用的默认执行模式 */
  defaultExecutionMode?: "direct" | "plan";
}

/** frontmatter 解析结果。 */
export interface ParsedSkill {
  name: string;
  description: string;
  tools?: string[];
  version?: string;
  effectKind?: ToolEffectKind;
  modes?: SkillMode[];
  hiddenFromUi?: boolean;
  body: string;  // SKILL.md 正文（frontmatter 之后）
}
