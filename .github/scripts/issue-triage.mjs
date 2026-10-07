// Issue 自动分流 —— 新 Issue 打开时给出三类判断并打对应标签。
//
// 行为边界（改动前请先读）：
// - 分流部分只打标签提示，不替维护者承诺任何处理时间；
// - 唯一的例外是模板闸门：正文里找不到模板声明行时，会评论 + 打标 + 关闭（not planned）。
//   「没走模板」是机器能确定的事实判定，不是对内容质量的评价，所以可以自动处置；
// - 结论来自「GitHub 搜索候选 + 模型语义比对」，仅供参考、可能出错，人工可随时移除标签；
// - 仅在 issues.opened 触发，天然每个 Issue 只跑一次，不需要额外限频；
// - Issue 标题与正文一律从事件 JSON 读取，不经过 shell 插值，避免命令注入。
//
// 模型提供方二选一：
// - 未配置 LLM_BASE_URL / LLM_MODEL 时走 GitHub Models（复用 GITHUB_TOKEN，零额外密钥）；
// - 配置后走自有 OpenAI 兼容端点，密钥取自 LLM_API_KEY。
// 两个变量必须成对配置，只填其一视为配置错误并跳过判断，避免半配置状态下静默走错提供方。

import { readFileSync } from "node:fs";

const API_BASE = "https://api.github.com";
const GITHUB_MODELS_ENDPOINT = "https://models.github.ai/inference/chat/completions";
const DEFAULT_GITHUB_MODELS_MODEL = "openai/gpt-4o-mini";

// 机器人可打的标签全集。命名一律用中性描述，因为标签对报告者可见：
// 「需要补充信息」而非「模糊」、「疑似重复」而非「重复」——避免让好心反馈的人被评判感。
const LABELS = {
  duplicate: {
    name: "possible-duplicate",
    color: "d4c5f9",
    description: "疑似与已有 Issue 重复（自动分流，仅供参考，可随时移除）",
  },
  needsInfo: {
    name: "needs-info",
    color: "fbca04",
    description: "缺少定位问题所需的可核查信息，待补充（自动分流，可随时移除）",
  },
  needsMaintainer: {
    name: "needs-maintainer",
    color: "1d76db",
    description: "涉及架构、权限边界或安全，需维护者亲自判断（自动分流）",
  },
};

// 模板闸门：Issue 正文里必须能找到这句声明，否则判定为「没走模板」。
// 这句话与 .github/ISSUE_TEMPLATE/ 下 7 个模板里的必勾选项逐字对应，改模板时必须同步改这里，
// 否则会把所有老老实实走模板的人一起误判掉。
// 只匹配复选框 label 中间这段固定短语，不依赖 `- [x]` 的大小写、空格和前后缀写法。
const TEMPLATE_SENTINEL = /本\s*Issue\s*由我本人阅读、核对并整理/;

// 闸门专用标签。刻意与下面三类分流标签分开：它由固定规则命中，不来自模型判断，
// 也不参与「三类标签是否都已存在」的提前返回判断。
const GATE_LABEL = {
  name: "needs-template",
  color: "6e7781",
  description: "未按 Issue 模板提交，已自动关闭（按模板重提后可重开）",
};

// 判重所需的最低置信度。设为 high 是刻意保守：
// 误标一个「好心来提 bug」的人，比漏标一次的代价大得多。
const REQUIRED_DUPLICATE_CONFIDENCE = "high";

const MAX_CANDIDATES = 8;
const MAX_BODY_CHARS = 1500;
const MAX_CANDIDATE_SNIPPET = 500;

// 这些词区分度太低，参与搜索只会把无关 Issue 拉进来
const STOPWORDS = new Set([
  "the", "and", "for", "with", "not", "issue", "bug", "error", "failed",
  "问题", "无法", "不能", "出现", "请求", "希望", "建议", "使用", "时候",
  "一个", "这个", "那个", "可以", "已经", "还是", "就是", "没有", "什么",
]);

// 常见功能字：以它们开头的双字词基本不携带检索价值，先剔掉减少噪声
const FUNCTION_CHARS = new Set("的了是不和与在有就都也而及或后时这那我你他它们请要把被让给对从向还很更最么呢啊吧");

const MAX_SEARCH_TERMS = 4;

const token = process.env.GITHUB_TOKEN ?? "";
const repoFullName = process.env.GITHUB_REPOSITORY ?? "";
const eventPath = process.env.GITHUB_EVENT_PATH ?? "";

function fail(message) {
  console.error(`[issue-triage] ${message}`);
  process.exit(1);
}

if (!token) fail("缺少 GITHUB_TOKEN");
if (!repoFullName.includes("/")) fail("缺少 GITHUB_REPOSITORY");
if (!eventPath) fail("缺少 GITHUB_EVENT_PATH");

const [owner, repo] = repoFullName.split("/");

function api(path, init = {}) {
  return fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "cyrene-issue-triage",
      ...(init.headers ?? {}),
    },
  });
}

function truncate(text, limit) {
  const value = (text ?? "").trim();
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

// 从长串里按顺序均匀取样，保证首尾和中间都有代表，而不是只取到开头几个词
function sampleEvenly(items, count) {
  if (count <= 0) return [];
  if (items.length <= count) return items;
  if (count === 1) return [items[0]];
  const picked = [];
  for (let i = 0; i < count; i += 1) {
    picked.push(items[Math.round((i * (items.length - 1)) / (count - 1))]);
  }
  return picked;
}

function cjkBigrams(run) {
  const chars = [...run];
  const grams = [];
  for (let i = 0; i < chars.length - 1; i += 1) {
    const gram = chars[i] + chars[i + 1];
    if ([...gram].some((char) => FUNCTION_CHARS.has(char))) continue;
    grams.push(gram);
  }
  return grams;
}

// 从标题里挑区分度最高的检索词。
// 中文没有空格分词，按标点切段往往只能得到一整个长句，拿去搜索召回极差
// （实测整句命中 0 条，拆成双字词可得数十条），所以中文段改取双字词。
// 搜索只负责把候选拉回来，精度交给模型判断，因此这里宁可多些噪声也要保住召回。
function extractKeywords(text) {
  const latin = [];
  const cjk = [];
  for (const segment of (text ?? "").toLowerCase().split(/[^a-z0-9\u4e00-\u9fff]+/u)) {
    if (segment.length < 2 || STOPWORDS.has(segment)) continue;
    if (/^[a-z0-9]+$/.test(segment)) latin.push(segment);
    else cjk.push(...cjkBigrams(segment));
  }

  const latinTerms = [...new Set(latin)];
  const cjkTerms = [...new Set(cjk)];

  // GitHub 搜索最多允许 5 个布尔运算符，取 4 个词（3 个 OR）留足余量；
  // 混排标题优先保留英文词，剩余名额给中文双字词
  const head = latinTerms.slice(0, MAX_SEARCH_TERMS);
  const rest = sampleEvenly(cjkTerms, MAX_SEARCH_TERMS - head.length);
  return [...head, ...rest];
}

async function searchCandidates(issue, keywords) {
  if (keywords.length === 0) return [];
  const query = `repo:${owner}/${repo} is:issue ${keywords.join(" OR ")}`;
  const res = await api(`/search/issues?per_page=${MAX_CANDIDATES}&sort=relevance&q=${encodeURIComponent(query)}`);
  if (!res.ok) {
    // 搜索失败只影响重复判断，其余两类标签仍可继续，因此返回空数组而不中断
    console.warn(`[issue-triage] 搜索候选失败（${res.status}）`);
    return [];
  }
  const data = await res.json();
  return (data.items ?? []).filter((item) => item.number !== issue.number);
}

function resolveProvider() {
  const baseUrl = (process.env.LLM_BASE_URL ?? "").trim().replace(/\/+$/, "");
  const model = (process.env.LLM_MODEL ?? "").trim();
  if (baseUrl && model) {
    const apiKey = (process.env.LLM_API_KEY ?? "").trim();
    if (!apiKey) {
      console.warn("[issue-triage] 配置了自有端点但缺少 LLM_API_KEY，本次跳过");
      return null;
    }
    return { endpoint: `${baseUrl}/chat/completions`, model, apiKey };
  }
  if (baseUrl || model) {
    console.warn("[issue-triage] LLM_BASE_URL 与 LLM_MODEL 必须成对配置，本次跳过");
    return null;
  }
  return { endpoint: GITHUB_MODELS_ENDPOINT, model: DEFAULT_GITHUB_MODELS_MODEL, apiKey: token };
}

function buildSystemPrompt() {
  return [
    "你是开源仓库的 Issue 分流助手。给你一条新 Issue 和一组已有的相似 Issue 候选，你要给出三类判断。",
    "判断看问题的实质（触发场景、报错、涉及模块），不要只看标题用词是否相似。",
    "三条共同的底线：拿不准就不要打标。被误标的人往往是好心来反馈的，误标比漏标代价大。",
    "",
    "判断一 duplicate：新 Issue 是否与某个候选指向同一个问题。",
    "仅有确实同一问题时才给 high；主题相近但场景或现象不同的给 medium 或 low；无法判断给 low。",
    "",
    "判断二 needsInfo：是否缺少定位问题所必需、且报告者本可以提供的可核查信息。",
    "只看这几种：没有可复现的步骤、没有版本或提交号、没有报错信息或日志。",
    "注意仓库的 Issue 模板已把这些字段设为必填，所以只有当填写内容无效时才打标",
    "（例如复现步骤写成「打开就崩了」而没有具体操作、版本号写成「最新」）。",
    "只是描述简短但信息完整，不要打标。功能请求与方案讨论不打标。",
    "",
    "判断三 needsMaintainer：是否必须由维护者亲自定夺。判定范围要窄，只限这三种情形：",
    "涉及架构或设计层面的决策；涉及权限边界；涉及安全。",
    "另外，需要维护者明确拒绝或澄清的深度讨论也算。",
    "普通 bug、普通功能请求、普通使用疑问一律不打标——它们不需要维护者亲自出面。",
    "",
    "只输出一个 JSON 对象，不要解释、不要代码块包裹，格式为：",
    '{"duplicateOf": <候选编号或 null>, "duplicateConfidence": "high|medium|low", "needsInfo": <true|false>, "needsMaintainer": <true|false>, "reason": "<一句中文理由>"}',
  ].join("\n");
}

function buildUserPrompt(issue, candidates) {
  const candidateList = candidates.length
    ? candidates
        .map((item) => `#${item.number} [${item.state}] ${item.title}\n${truncate(item.body, MAX_CANDIDATE_SNIPPET)}`)
        .join("\n\n---\n\n")
    : "（没有搜到相似候选）";

  return [
    "【新 Issue】",
    `标题：${issue.title}`,
    `正文：${truncate(issue.body, MAX_BODY_CHARS)}`,
    "",
    "【已有 Issue 候选】",
    candidateList,
  ].join("\n");
}

function parseVerdict(content) {
  if (typeof content !== "string") return null;
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;
  try {
    return JSON.parse(content.slice(start, end + 1));
  } catch {
    return null;
  }
}

async function judge(provider, issue, candidates) {
  const res = await fetch(provider.endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${provider.apiKey}`,
      "Content-Type": "application/json",
      "User-Agent": "cyrene-issue-triage",
    },
    body: JSON.stringify({
      model: provider.model,
      messages: [
        { role: "system", content: buildSystemPrompt() },
        { role: "user", content: buildUserPrompt(issue, candidates) },
      ],
      temperature: 0,
    }),
  });
  if (!res.ok) {
    console.warn(`[issue-triage] 模型调用失败（${res.status}），本次跳过`);
    return null;
  }
  const data = await res.json();
  return parseVerdict(data.choices?.[0]?.message?.content);
}

// 从模型输出里挑出该打、且当前还没有的标签
function selectLabels(verdict, candidates, existingLabels) {
  const picked = [];

  const duplicateNumber = verdict.duplicateOf;
  const isValidDuplicate =
    Number.isInteger(duplicateNumber) &&
    candidates.some((item) => item.number === duplicateNumber) &&
    verdict.duplicateConfidence === REQUIRED_DUPLICATE_CONFIDENCE;
  if (isValidDuplicate) picked.push(LABELS.duplicate);

  if (verdict.needsInfo === true) picked.push(LABELS.needsInfo);
  if (verdict.needsMaintainer === true) picked.push(LABELS.needsMaintainer);

  return picked.filter((label) => !existingLabels.includes(label.name));
}

async function ensureLabel(label) {
  const res = await api(`/repos/${owner}/${repo}/labels`, {
    method: "POST",
    body: JSON.stringify({ name: label.name, color: label.color, description: label.description }),
  });
  // 422 表示标签已存在，属于预期结果
  if (!res.ok && res.status !== 422) {
    console.warn(`[issue-triage] 创建标签 ${label.name} 失败（${res.status}）`);
  }
}

async function addLabels(issueNumber, names) {
  const res = await api(`/repos/${owner}/${repo}/issues/${issueNumber}/labels`, {
    method: "POST",
    body: JSON.stringify({ labels: names }),
  });
  if (!res.ok) {
    console.warn(`[issue-triage] 添加标签失败（${res.status}）`);
    return false;
  }
  return true;
}

async function commentIssue(issueNumber, body) {
  const res = await api(`/repos/${owner}/${repo}/issues/${issueNumber}/comments`, {
    method: "POST",
    body: JSON.stringify({ body }),
  });
  if (!res.ok) {
    console.warn(`[issue-triage] 评论失败（${res.status}）`);
    return false;
  }
  return true;
}

async function closeIssue(issueNumber) {
  const res = await api(`/repos/${owner}/${repo}/issues/${issueNumber}`, {
    method: "PATCH",
    // not_planned 而非 completed：这条单没有被处理，只是被退回
    body: JSON.stringify({ state: "closed", state_reason: "not_planned" }),
  });
  if (!res.ok) {
    console.warn(`[issue-triage] 关闭失败（${res.status}）`);
    return false;
  }
  return true;
}

// 中英双语：仓库里存在纯英文标题的 Issue，只写中文会让那部分人不知道发生了什么
function buildTemplateReminder() {
  const link = `https://github.com/${owner}/${repo}/issues/new/choose`;
  return [
    "> [!IMPORTANT]",
    "> 这条 Issue 没有走本仓库的 Issue 模板，已由机器人自动关闭。",
    "> 这不是对你个人的判断，只是流程上的要求，请不要因此停下反馈。",
    "",
    `请回到 [新建 Issue](${link}) 选择对应模板重新提交。模板里的字段会引导你把复现步骤、版本号、日志和源码依据一次讲清楚，处理速度差别很大。`,
    "",
    "按模板重新提交后，请在本条下方回复一声，我会把它重新打开。",
    "",
    "---",
    "",
    `This issue was automatically closed because it was not submitted through one of this repository's [issue templates](${link}).`,
    "",
    "Please re-submit using the matching template, then leave a comment here and we will reopen this one.",
  ].join("\n");
}

async function rejectOffTemplateIssue(issue) {
  await ensureLabel(GATE_LABEL);
  const labeled = await addLabels(issue.number, [GATE_LABEL.name]);
  const commented = await commentIssue(issue.number, buildTemplateReminder());
  const closed = await closeIssue(issue.number);
  return labeled && commented && closed;
}

async function main() {
  const event = JSON.parse(readFileSync(eventPath, "utf8"));
  const issue = event.issue;
  if (!issue) {
    console.log("[issue-triage] 非 issue 事件，跳过");
    return;
  }

  // 维护者、协作成员和机器人自己的 Issue 不需要分流
  const skipAssociations = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
  if (issue.user?.type === "Bot" || skipAssociations.has(issue.author_association)) {
    console.log("[issue-triage] 维护者或机器人自己的 Issue，跳过");
    return;
  }

  const existingLabels = (issue.labels ?? []).map((label) => (typeof label === "string" ? label : label.name));
  if (Object.values(LABELS).every((label) => existingLabels.includes(label.name))) {
    console.log("[issue-triage] 三类标签都已存在，跳过");
    return;
  }

  // 模板闸门：没走模板的直接退回，不进入下面的模型分流，省一次调用。
  // 放在分流之前是刻意的——分流是「帮报告者改进」，闸门是「这份报告还没进入流程」。
  if (!TEMPLATE_SENTINEL.test(issue.body ?? "")) {
    const rejected = await rejectOffTemplateIssue(issue);
    console.log(rejected ? "[issue-triage] 未走模板，已评论、打标并关闭" : "[issue-triage] 未走模板，处置中有失败项");
    return;
  }

  const provider = resolveProvider();
  if (!provider) return;

  const candidates = await searchCandidates(issue, extractKeywords(issue.title));
  const verdict = await judge(provider, issue, candidates);
  if (!verdict) {
    console.log("[issue-triage] 未得到有效判断，跳过");
    return;
  }

  const picked = selectLabels(verdict, candidates, existingLabels);
  const confidence = typeof verdict.duplicateConfidence === "string" ? verdict.duplicateConfidence : "unknown";
  console.log(
    `[issue-triage] 候选 ${candidates.length} 条，判定 duplicate=${verdict.duplicateOf ?? "null"}/${confidence}` +
      ` needsInfo=${verdict.needsInfo === true} needsMaintainer=${verdict.needsMaintainer === true}`,
  );
  if (picked.length === 0) {
    console.log("[issue-triage] 无需打标");
    return;
  }

  for (const label of picked) await ensureLabel(label);
  const names = picked.map((label) => label.name);
  const added = await addLabels(issue.number, names);
  console.log(added ? `[issue-triage] 已打标：${names.join(", ")}` : "[issue-triage] 打标失败");
}

await main();