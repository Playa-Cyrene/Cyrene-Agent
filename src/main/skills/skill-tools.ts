// Skill meta-tool —— 把 skill 系统暴露给 LLM 的两个工具。
// 不把每个 skill 注册成业务 tool（skill 是指令层），而是用两个 meta-tool：
//   invoke_skill：加载某 skill 的 SKILL.md 正文 + references 清单
//   read_skill_reference：按需读 references 附件（带路径穿越防护）
// 注册进现有 toolRegistry，两处 LLM 路径都从 registry 取，自动生效。

import { toolRegistry } from "../orchestrator/tools/registry/tool-registry";
import { skillRegistry } from "./skill-registry";
import { logger, LogTag } from "../logger";
import type { ToolContext } from "../orchestrator/tools/registry/tool-context";

const LOG_PREFIX = "[SkillTools]";

// skill 正文 / reference 返回时的字符上限。CyreneAgent 的 FC 循环把 tool 返回值
// 永久留在 conversation 里，超大正文（xlsx 8.5KB、skill-creator 33KB、docx 的
// openxml_encyclopedia 单个 144KB）会顶过推理模型单轮 30s 预算导致连续超时。
// 官方 skill 系统靠宿主 agent（Claude Code 等）的上下文压缩兜底，我们没那层，得自己截断。
const SKILL_BODY_MAX_CHARS = 6000;
const SKILL_REF_MAX_CHARS = 8000;

export function isSkillAllowedForRun(id: string, allowedSkillIds?: ReadonlySet<string>): boolean {
  return allowedSkillIds?.has(id) ?? true;
}

/** 截断文本到 maxChars，超长时末尾附提示。保留前部（任务路由表/关键规则通常在前）。 */
function truncateForContext(text: string, maxChars: number, hint: string): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) +
    "\n\n[...正文过长已截断，仅显示前 " + maxChars + " 字符。" + hint + "...]";
}

/**
 * 每轮对话的 reference 已读记录（skill_id + ref → true）。
 * FC 循环开始时调 resetReadRefs() 清空。防止模型在同一轮任务里重复读同一文件。
 */
const readRefs = new Set<string>();
let readRefsByContext = new WeakMap<ToolContext, Set<string>>();

function referenceReads(context?: ToolContext): Set<string> {
  if (!context) return readRefs;
  let refs = readRefsByContext.get(context);
  if (!refs) {
    refs = new Set();
    readRefsByContext.set(context, refs);
  }
  return refs;
}

/** 每轮 FC 循环开始前调，清空已读记录。由 cyrene-agent.ts 在循环入口调。 */
export function resetReadRefs(): void {
  readRefs.clear();
  readRefsByContext = new WeakMap();
}

/**
 * 执行纪律提示，拼在 invoke_skill 返回内容末尾。
 * 约束模型"够用即执行、不重复读、不探索式遍历"，避免浪费轮数。
 */
const EXECUTION_DISCIPLINE =
  "\n\n---\n" +
  "【执行纪律 — 必须遵守】\n" +
  "1. 只读完成任务所需的最少 reference，读到能执行就立即开始，不要把所有文档都读一遍。\n" +
  "2. 同一 reference 文件不要重复读取（系统会拦截重复读取）。\n" +
  "3. 不要用 list_dir 遍历 templates/scripts 目录——模板和脚本路径上文已给出，直接用。\n" +
  "4. 信息足够后立即用其他工具执行产出，不要继续研究。\n" +
  "5. 若预计轮数紧张，优先输出可交付版本而非继续优化格式。";

/**
 * 注册 skill 系统的两个 meta-tool 进 toolRegistry。
 * 标 risk:"safe"（只读本地 skill 文件），免权限打扰。
 * initSkills 启动时调一次。
 */
export function registerSkillTools(): void {
  toolRegistry.register({
    id: "invoke_skill",
    name: "调用 Skill",
    description:
      "加载某个 skill 的详细执行指令。当你判断当前任务适用某 skill 时（见系统提示里的「可用 Skill」清单），调用此工具获取该 skill 的完整指令，再按指令用其他工具执行。\n\n" +
      "何时用：系统提示的「可用 Skill」清单里某条 description 适用于当前任务。\n\n" +
      "不要用于：清单里没有的 skill id。\n\n" +
      "参数：skill_id（必填，skill 的 id，见清单里的标识）。\n\n" +
      "返回：该 skill 的指令正文 + 可用的 references 文件清单。若正文引用了 references/xxx，需要详情时再用 read_skill_reference 读取。",
    enabled: true,
    risk: "safe",
    // 这里只加载指令；技能后续使用的工具各自检查实际副作用和权限。
    effectKind: "read" as const,
    verificationPolicy: "none" as const,
    inputSchema: {
      type: "object",
      properties: {
        skill_id: { type: "string", description: "skill 的 id（见「可用 Skill」清单）" },
      },
      required: ["skill_id"],
    },
    needsContext: true,
    execute: async (args, ctx?: ToolContext) => {
      const id = String(args.skill_id || "");
      if (!isSkillAllowedForRun(id, ctx?.allowedSkillIds)) {
        return `[invoke_skill] E_SKILL_UNAVAILABLE_IN_MODE: ${id}`;
      }
      const skill = skillRegistry.getById(id);
      if (!skill || !skill.enabled || !skillRegistry.isAvailable(id)) {
        const available = skillRegistry.getEnabled().filter(s => isSkillAllowedForRun(s.id, ctx?.allowedSkillIds))
          .map(s => s.id).join(", ") || "(无)";
        return `[invoke_skill] skill not found: ${id}。可用 skill: ${available}`;
      }
      const body = skillRegistry.getBody(id);
      if (body === null) {
        return `[invoke_skill] 读取 skill 正文失败: ${id}`;
      }
      const refList = skill.references.length > 0
        ? `\n\n可用 references（需要详情时调 read_skill_reference 读取）：\n${skill.references.map(r => "- " + r).join("\n")}`
        : "";
      console.log(LOG_PREFIX, "invoke_skill:", id, "bodyLen=" + body.length);
      const truncatedBody = truncateForContext(
        body,
        SKILL_BODY_MAX_CHARS,
        "如需完整指令或特定部分，可用 read_skill_reference 精准读取对应 reference 文件",
      );
      return `[已加载 skill: ${id}]\n${truncatedBody}${refList}${EXECUTION_DISCIPLINE}`;
    },
  });

  toolRegistry.register({
    id: "read_skill_reference",
    name: "读取 Skill 附件",
    description:
      "读取某 skill 的 references 附件内容。当 invoke_skill 返回的正文引用了 references/xxx 且你需要详情时调用。\n\n" +
      "何时用：invoke_skill 返回的正文提到 references/xxx 且需要该附件的详细内容。\n\n" +
      "不要用于：不在 invoke_skill 返回清单里的 ref。\n\n" +
      "参数：skill_id（必填），ref（必填，references 文件名，必须是 invoke_skill 返回清单里的）。",
    enabled: true,
    risk: "safe",
    effectKind: "read" as const,
    verificationPolicy: "none" as const,
    inputSchema: {
      type: "object",
      properties: {
        skill_id: { type: "string", description: "skill 的 id" },
        ref:      { type: "string", description: "references 文件名（必须命中 invoke_skill 返回的清单）" },
      },
      required: ["skill_id", "ref"],
    },
    needsContext: true,
    execute: async (args, ctx?: ToolContext) => {
      const id = String(args.skill_id || "");
      const ref = String(args.ref || "");
      if (!isSkillAllowedForRun(id, ctx?.allowedSkillIds)) {
        return `[read_skill_reference] E_SKILL_UNAVAILABLE_IN_MODE: ${id}`;
      }
      const skill = skillRegistry.getById(id);
      if (!skill || !skill.enabled || !skillRegistry.isAvailable(id)) {
        return `[read_skill_reference] skill not found: ${id}`;
      }
      // 去重：同一轮内同一 reference 不重复返回（内容已在对话历史里，再读浪费轮数+token）
      // 主代理与各子任务独立去重，各自的上下文需要各自读取一次。
      const reads = referenceReads(ctx);
      const readKey = `${id}/${ref}`;
      if (reads.has(readKey)) {
        return `[read_skill_reference] "${ref}" 已在本轮读过，内容已在对话中，不要重复读取。` +
          `如需其他文件，可读：${skill.references.filter(r => !reads.has(`${id}/${r}`)).join(", ") || "(全部已读)"}`;
      }
      const content = skillRegistry.getReference(id, ref);
      if (content === null) {
        return `[read_skill_reference] 读取失败（ref 不在清单或文件不存在）: ${ref}。可用: ${skill.references.join(", ") || "(无)"}`;
      }
      reads.add(readKey);
      console.log(LOG_PREFIX, "read_skill_reference:", id, ref, "len=" + content.length);
      const truncated = truncateForContext(
        content,
        SKILL_REF_MAX_CHARS,
        "如需后半部分内容，请分段读取或说明你需要的具体章节",
      );
      return truncated;
    },
  });

  logger.info(LogTag.SkillTools, "registered: invoke_skill / read_skill_reference");
}
