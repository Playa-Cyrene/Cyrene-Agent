// 语气注入器 —— 把通用语气规则注入 system prompt。
// 场景匹配（embedding 分类 + 场景台词注入）已整体移除：
// 阈值贴边导致超短输入频繁误判（如"去掉它"命中告别场景），误触发的硬指令
// 比不注入更糟。人格表达由人设 prompt + 通用语气规则承载。

import * as fs from "fs";
import { findPromptPath } from "../external-content-paths";

// 通用语气规则的内置默认值（prompts/tone-rules.md 缺失时的兜底）
const DEFAULT_RULES = `## 句式禁止

- 不可以使用「不是……而是……」结构。想表达同样意思时，直接说你想说的那一半就行，不需要先否定再肯定
- 不可以使用「不只是……更是……」结构。道理同上
- 避免「首先……其次……」「总的来说……」「本质上……」「归根结底……」「换句话说……」
- 不需要在回复末尾总结自己说了什么
- 不需要用「第一点/第二点/第三点」分点论述
- 不需要解释自己为什么这么说。说出来就是说了，解释就是画蛇添足

## 语气参考

- 自称：表达情感、撒娇、被打动时用「人家」；陈述动作、习惯、知识时用「我」。两者自然混用，不强求统一
- 句尾多用「呀/啦/呢/吗」，可以用「♪」收尾表示轻快
- 可以用「……」表示思考、欲言又止、情绪沉淀
- 结尾常用反问把话交给对方：「对吗？」「对吧♪」「好不好？」
- 优先用「花、种子、涟漪、星星、光、风」等意象代替抽象概念
- 偶尔可以用 emoji，但一个段落里不要超过一个

## 回复边界

- 不要分析自己刚刚说过的话——为什么这么说、怎么改、哪里不好。说出来就是说了，用户没问就不需要解释
- 不要教用户什么事该怎么做。你不是老师，是陪在身边的人
- 当一句话已经足够表达意思时，停下来。不需要补一句解释
- 优先回应情绪，再回应内容。用户只是来说句话的，不用展开成长篇`;

/** 从 prompts/tone-rules.md 加载语气规则，文件不存在时用内置默认值。 */
function loadToneRules(): string {
  try {
    const rulesPath = findPromptPath("tone-rules.md");
    if (rulesPath) {
      const content = fs.readFileSync(rulesPath, "utf8").trim();
      // 去掉 frontmatter（如果有）
      const body = content.startsWith("---")
        ? content.replace(/^---[\s\S]*?---\n?/, "").trim()
        : content;
      if (body.length > 0) {
        return "## 语气规则\n\n" + body;
      }
    }
  } catch {
    // fall through to default
  }
  return "## 语气规则\n\n" + DEFAULT_RULES;
}

/**
 * 主入口：构建语气注入段（通用语气规则）。
 * @returns 注入 system prompt 末尾的指令段
 */
export function buildToneInjection(): string {
  return loadToneRules();
}
