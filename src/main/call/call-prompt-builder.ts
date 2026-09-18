import { buildAlwaysOnContext, buildMemoryInjection } from "../orchestrator";
import { buildToneInjection } from "../orchestrator/tone-injector";
import { buildSkillCatalog, skillRegistry } from "../skills";
import { resolveSlashActivation } from "../skills/slash-activation";
import { resolveChatContextTimezone } from "../chat-time-context";
import { getDateLocale } from "../locale-context";
import { loadPromptFile } from "../prompts/prompt-loader";
import { loadUserProfile } from "../settings-store";
import { loadGeneralSettings } from "../settings/settings-facade";
import { searchMemoryEntries } from "../rag";
import { memoryStore } from "../memory/memory-store";
import { l2DmaeManager } from "../memory/l2-dmae-manager";

/**
 * 构建通话（Call）模式专用 system prompt。
 * 包含时间日期、常驻上下文、记忆注入、phone 人设文件、skill 约束、语气注入。
 * 注意：本函数会修改传入的 messages 数组以处理 /命令命中但未启用的情况。
 */
export async function buildCallSystemPrompt(
  userText: string,
  messages: Array<{ role: "user" | "assistant"; content: string }>,
): Promise<string> {
  // ① 时间日期（用用户时区，禁止直接喂未校验的 profile.timezone 给 Intl）
  const now = new Date();
  const userTz = resolveChatContextTimezone(loadUserProfile().timezone);
  const timeStr = `当前时间：${now.toLocaleDateString(getDateLocale(), { timeZone: userTz })} ${now.toLocaleTimeString(getDateLocale(), { hour: "2-digit", minute: "2-digit", timeZone: userTz })}`;

  // ② 常驻上下文（世界书 + L0/L1 画像）
  let alwaysOnContext = "";
  try { alwaysOnContext = await buildAlwaysOnContext(userText, messages); } catch { /* ignore */ }

  // ③ V5 L2 DMAE：先向量召回 top-4，再执行 DMAE 状态更新
  try {
    const allL2 = await memoryStore.getAllL2();
    const recalled = await searchMemoryEntries(userText, "user_memory", 4);
    const recalledIds = recalled
      .map((r) => r.metadata?.l2Id)
      .filter((id): id is string => typeof id === "string" && id.length > 0);
    const lastAssistant = [...messages]
      .reverse()
      .find((m) => m.role === "assistant")
      ?.content ?? "";
    await l2DmaeManager.updateActivation(allL2, userText, lastAssistant, recalledIds);
  } catch (err) {
    console.warn("[CallPromptBuilder] L2 DMAE update failed:", err);
  }

  // ④ 记忆注入（读取 DMAE active L2）
  let memoryInjection = "";
  try { memoryInjection = await buildMemoryInjection(userText); } catch { /* ignore */ }

  // ④ 通话专用人设 prompt
  const phoneParts: string[] = [];
  const phoneSystem = loadPromptFile("phone_system.md");
  if (phoneSystem) phoneParts.push(phoneSystem);
  const phoneIdentity = loadPromptFile("phone_identity.md");
  if (phoneIdentity) phoneParts.push(phoneIdentity);
  const soul = loadPromptFile("soul.md");
  if (soul) phoneParts.push(soul);
  const canon = loadPromptFile("canon_quotes.md");
  if (canon) phoneParts.push(canon);
  const phoneStyle = loadPromptFile("phone_style.md");
  if (phoneStyle) phoneParts.push(phoneStyle);
  const phonePrompt = phoneParts.join("\n\n---\n\n");

  // ⑤ Skill 约束（resolveSlashActivation 会原地修改 messages）
  // Call 模式按 work 模式过滤 skill，并尊重 skill-模式覆盖层。
  const skillCatalog = buildSkillCatalog(
    skillRegistry.getEnabledForMode("work", loadGeneralSettings().skillModeOverrides),
  );
  const skillActivation = resolveSlashActivation(messages, "work", loadGeneralSettings().skillModeOverrides);

  // ⑥ 语气注入（通用语气规则）
  const toneInjection = buildToneInjection();

  return timeStr + "\n\n" +
    (alwaysOnContext ? alwaysOnContext + "\n\n" : "") +
    (memoryInjection ? memoryInjection + "\n\n" : "") +
    phonePrompt +
    (skillCatalog ? "\n\n---\n\n" + skillCatalog : "") +
    skillActivation +
    toneInjection;
}
