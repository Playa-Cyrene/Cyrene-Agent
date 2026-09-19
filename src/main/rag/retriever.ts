import { JsonVectorStore, SearchResult } from "./vectorstore";
import { EmbeddingProvider, getEmbeddingProvider } from "./embedding";
import { getReranker } from "./reranker";

// ── @node-rs/jieba 分词（Node 24 兼容；nodejieba 已弃用） ──
import { Jieba } from "@node-rs/jieba";

const jieba = new Jieba();

interface TokenInfo {
  word: string;
  tag: string;       // 词性标注：n/ns/nr/v/a/d/p/c/u 等
  isStop: boolean;   // 是否为停用词/高频词
  isNoun: boolean;   // 是否为名词或专名
}

// ── 常用停用词（~120 个高频无意义字/词） ──
const STOP_WORDS = new Set([
  "的", "了", "是", "在", "我", "你", "他", "她", "它",
  "有", "不", "也", "就", "都", "这", "那", "还", "要",
  "和", "与", "或", "但", "而", "且", "及", "之", "为",
  "上", "下", "中", "里", "外", "前", "后", "左", "右",
  "到", "去", "来", "从", "把", "被", "让", "给", "对",
  "吗", "呢", "吧", "啊", "嘛", "哦", "嗯", "呀", "哇",
  "很", "太", "更", "最", "非", "没", "将", "已", "能",
  "会", "可", "以", "好", "多", "少", "大", "小", "真",
  "个", "些", "点", "样", "种", "些", "哪", "谁", "什",
  "做", "当", "看", "听", "说", "想", "觉", "知", "道",
  "过", "完", "着", "住", "得", "地", "于", "其", "该",
  "我们", "你们", "他们", "她们", "它们",
  "自己", "什么", "怎么", "为什么", "因为", "所以",
  "这个", "那个", "这些", "那些", "这里", "那里",
  "一个", "一种", "一些", "的话", "时候", "地方",
  "东西", "事情", "问题", "就是", "可以", "但是",
  "没有", "不要", "不是", "不会", "不能", "应该",
  "已经", "可能", "觉得", "知道", "告诉",
]);

// 非名词/非动词的常见虚词性标签（BM25 应降权处理）
const STOP_TAGS = new Set(["u", "c", "p", "d", "r", "y", "o", "e", "m", "q", "f"]);
// 名词性标签（需加权）
const NOUN_TAGS = new Set(["n", "nr", "ns", "nt", "nz", "ng", "vn", "an"]);

/** 停用词降权系数 */
const STOP_WEIGHT = 0.3;
/** 名词加权系数 */
const NOUN_WEIGHT = 1.3;

export interface RetrieveOptions {
  importIds?: string[];
  allowedEntryIds?: string[];
}

// ── 自定义词表（entity-graph 维护）──
// @node-rs/jieba 没有运行时 insertWord()，改用「后处理重组」方案：
// jieba 切完后，把被切散的自定义词（如"昔涟"→"昔","涟"）重新合并。
const customWords = new Set<string>();
// 自定义词表版本：每次真正新增词时递增，让已缓存的文档分词作废重算
let customWordsVersion = 0;

/** 注册一个自定义词（让分词时不被切散） */
export function registerJiebaCustomWord(word: string): void {
  if (word.length >= 2 && !customWords.has(word)) customWordsVersion++;
  customWords.add(word);
}

/** 批量注册自定义词 */
export function registerJiebaCustomWords(words: Iterable<string>): void {
  for (const w of words) {
    if (w.length >= 2 && !customWords.has(w)) customWordsVersion++;
    customWords.add(w);
  }
}

/** 后处理：在 jieba.cut() 的结果里，把属于自定义词的连续 token 合并 */
function mergeCustomWords(tokens: string[]): string[] {
  if (customWords.size === 0 || tokens.length < 2) return tokens;

  // 按长度倒序排序，优先匹配长词（避免"昔涟小助手"被错误合并成"昔涟小助手"）
  const sortedWords = [...customWords].sort((a, b) => b.length - a.length);

  // 用"窗口匹配"扫描：找到第一个能匹配的位置，合并若干个 token 为一个词
  const result: string[] = [];
  let i = 0;
  while (i < tokens.length) {
    let matched = false;
    for (const word of sortedWords) {
      const wordTokens = word.split(""); // 单字数组
      // 检查从 i 开始的连续 token 是否能拼成 word
      let ok = true;
      for (let j = 0; j < wordTokens.length; j++) {
        if (i + j >= tokens.length || tokens[i + j] !== wordTokens[j]) {
          ok = false;
          break;
        }
      }
      if (ok) {
        result.push(word);
        i += wordTokens.length;
        matched = true;
        break;
      }
    }
    if (!matched) {
      result.push(tokens[i]);
      i++;
    }
  }
  return result;
}

function tokenize(text: string): TokenInfo[] {
  // 纯英文/数字文本走原来的空格分词逻辑（jieba 不适合纯英文）
  if (/^[a-zA-Z0-9\s]+$/.test(text)) {
    return text.split(/\s+/).filter(Boolean).map((word) => ({
      word: word.toLowerCase(),
      tag: "eng",
      isStop: false,
      isNoun: false,
    }));
  }

  try {
    // 第二个参数 hmm=true 让 jieba 用 HMM 模型识别未登录词（如角色名"昔涟"）
    // 默认词典不含"昔涟"等角色名，但 HMM 能根据上下文判断这是个整体
    // 再叠加后处理：把 jieba 切散的自定义词重组
    const rawCuts = jieba.cut(text, true);
    const mergedCuts = mergeCustomWords(rawCuts);

    // 用 jieba.tag 给重组后的词打标签（每个"词"独立 tag）
    // 重组后词和原文本不对齐，所以对每个 merged token 单独 tag
    const result: TokenInfo[] = [];
    for (const word of mergedCuts) {
      const tagged = jieba.tag(word, true);
      const first = tagged[0] ?? { word, tag: "x" };
      result.push({
        word: word.toLowerCase(),
        tag: first.tag,
        isStop: STOP_WORDS.has(word) || STOP_TAGS.has(first.tag),
        isNoun: NOUN_TAGS.has(first.tag),
      });
    }
    return result;
  } catch {
    // jieba 失败时回退到单字切分
    const tokens: TokenInfo[] = [];
    const seg = text.split(/([\u4e00-\u9fff]|[a-zA-Z]+|\d+)/).filter(Boolean);
    for (const s of seg) {
      if (/[\u4e00-\u9fff]/.test(s)) {
        for (const c of s) {
          tokens.push({ word: c, tag: "x", isStop: STOP_WORDS.has(c), isNoun: false });
        }
      } else {
        tokens.push({ word: s.toLowerCase(), tag: "eng", isStop: false, isNoun: false });
      }
    }
    return tokens;
  }
}

// ── BM25 文档分词缓存 ──
// 条目文本写入后不可变，分词结果直接挂在条目对象上：条目删除后随 GC 回收，无需失效逻辑。
// 全库分词是 BM25 的绝对大头（3000 个 chunk 约 2.5 秒），缓存后只在首次检索付出一次成本。
// 自定义词表更新会改变分词结果，用版本号比对决定是否重算。
const docTokenCache = new WeakMap<object, { version: number; tokens: TokenInfo[] }>();

function getDocTokens(entry: object & { text: string }): TokenInfo[] {
  const cached = docTokenCache.get(entry);
  if (cached && cached.version === customWordsVersion) return cached.tokens;
  const tokens = tokenize(entry.text);
  docTokenCache.set(entry, { version: customWordsVersion, tokens });
  return tokens;
}

function bm25Score(
  queryTokens: TokenInfo[],
  docTokens: TokenInfo[],
  docFreq: Map<string, number>,
  totalDocs: number,
  avgDocLen: number
): number {
  const k1 = 1.2;
  const b = 0.75;
  let score = 0;

  // 文档词频
  const tf: Map<string, number> = new Map();
  for (const t of docTokens) {
    tf.set(t.word, (tf.get(t.word) || 0) + 1);
  }

  for (const qt of queryTokens) {
    const df = docFreq.get(qt.word) || 0;
    if (df === 0) continue;

    const idf = Math.log((totalDocs - df + 0.5) / (df + 0.5) + 1);
    const termFreq = tf.get(qt.word) || 0;
    const numerator = termFreq * (k1 + 1);
    const denominator = termFreq + k1 * (1 - b + b * (avgDocLen ? docTokens.length / avgDocLen : 1));
    let termScore = idf * (numerator / denominator);

    // 名词加权：实际的信息载体，提高权重
    if (qt.isNoun) termScore *= NOUN_WEIGHT;
    // 停用词降权：高频无意义词，降低干扰
    if (qt.isStop) termScore *= STOP_WEIGHT;

    score += termScore;
  }

  return score;
}

// ── 混合检索器 ──
export class HybridRetriever {
  private store: JsonVectorStore;
  private provider: EmbeddingProvider | null;

  constructor(store: JsonVectorStore, provider?: EmbeddingProvider | null) {
    this.store = store;
    this.provider = provider ?? null;
  }

  async retrieve(
    query: string,
    source?: string,
    topK = 5,
    options: RetrieveOptions = {},
    vectorWeight = 0.7,
    bm25Weight = 0.3
  ): Promise<SearchResult[]> {
    const stats = this.store.stats;
    if (stats.total === 0) return [];

    // 如果没有 provider，向量检索不可用，只用 BM25
    if (!this.provider) {
      const bm25Results = this.bm25Search(query, source, topK, options);
      return bm25Results;
    }

    // 1. Vector 检索
    const vectorResults = await this.store.search(query, source, this.provider, topK * 3, 0.3, options);

    // 2. BM25 检索
    const bm25Results = this.bm25Search(query, source, topK * 3, options);

    // 3. 融合：加权求和
    const merged: Map<string, { result: SearchResult; vectorScore: number; bm25Score: number }> = new Map();

    for (const r of vectorResults) {
      merged.set(r.entry.id, { result: r, vectorScore: r.score, bm25Score: 0 });
    }

    for (const r of bm25Results) {
      const existing = merged.get(r.entry.id);
      if (existing) {
        existing.bm25Score = r.score;
      } else {
        merged.set(r.entry.id, { result: r, vectorScore: 0, bm25Score: r.score });
      }
    }

    // 归一化 + 加权
    const all = Array.from(merged.values());
    const maxV = Math.max(...all.map((m) => m.vectorScore), 1);
    const maxB = Math.max(...all.map((m) => m.bm25Score), 1);

    const scored = all.map((m) => ({
      ...m.result,
      score: (m.vectorScore / maxV) * vectorWeight + (m.bm25Score / maxB) * bm25Weight,
    }));

    scored.sort((a, b) => b.score - a.score);
    const candidates = scored.slice(0, topK);

    // ── Reranker 精排 ──
    // 如果 reranker 可用，用 cross-encoder 对候选结果做精排
    const reranker = getReranker();
    if (reranker && candidates.length > 1) {
      try {
        const docs = candidates.map((c) => c.entry.text);
        const reranked = await reranker.rerank(query, docs);
        const scoreMap = new Map(reranked.map((r) => [r.text, r.score]));

        // 用 reranker 分数重排，但保留原始 hybrid 分数作为参考
        for (const c of candidates) {
          const rerankScore = scoreMap.get(c.entry.text);
          if (rerankScore !== undefined) {
            c.score = rerankScore;
          }
        }
        candidates.sort((a, b) => b.score - a.score);
      } catch (err) {
        console.warn("[HybridRetriever] reranker failed, using hybrid scores:", err);
      }
    }

    return candidates;
  }

  /**
   * 后台预热 BM25 分词缓存：把"首次检索才付全库分词成本"挪到导入完成的时刻。
   * 分片执行（每片 50 条、片间用 setImmediate 让出事件循环），单片只占毫秒级，
   * 不会像冷检索那样一次阻塞主线程两秒。失败静默——预热只是提前填缓存，
   * 检索路径自身始终能补算，正确性不依赖本方法。
   * 返回 Promise 供需要等待预热的调用方（如基准测试）使用，生产路径可不等待。
   */
  warmupBm25Tokens(entries: Array<{ text: string }>): Promise<void> {
    return new Promise((resolve) => {
      const total = entries.length;
      if (total === 0) {
        resolve();
        return;
      }
      const BATCH = 50;
      const warm = (start: number) => {
        try {
          const end = Math.min(start + BATCH, total);
          for (let i = start; i < end; i++) {
            getDocTokens(entries[i]);
          }
        } catch (err) {
          console.warn("[HybridRetriever] BM25 warmup failed:", err);
          resolve();
          return;
        }
        if (start + BATCH < total) {
          setImmediate(() => warm(start + BATCH));
        } else {
          resolve();
        }
      };
      setImmediate(() => warm(0));
    });
  }

  private bm25Search(query: string, source?: string, topK = 15, options: RetrieveOptions = {}): SearchResult[] {
    const entries = this.store["entries"] as Array<{
      id: string; text: string; embedding: number[]; source: string;
      weight: number; createdAt: number; lastRecalledAt: number; metadata?: Record<string, unknown>;
    }>;

    const allowedImportIds = new Set(options.importIds ?? []);
    const allowedEntryIds = options.allowedEntryIds ? new Set(options.allowedEntryIds) : null;
    const docs = (source ? entries.filter((e) => e.source === source) : entries).filter((entry) =>
      (!allowedImportIds.size || allowedImportIds.has(String(entry.metadata?.importId ?? ""))) &&
      (!allowedEntryIds || allowedEntryIds.has(entry.id)),
    );
    if (docs.length === 0) return [];

    const queryTokenInfo = tokenize(query);
    const docTokensList = docs.map((d) => getDocTokens(d));
    const totalDocs = docs.length;
    const avgDocLen = docTokensList.reduce((sum, t) => sum + t.length, 0) / totalDocs;

    // 文档频率
    const docFreq = new Map<string, number>();
    for (const tokens of docTokensList) {
      const seen = new Set<string>();
      for (const t of tokens) {
        if (!seen.has(t.word)) {
          docFreq.set(t.word, (docFreq.get(t.word) || 0) + 1);
          seen.add(t.word);
        }
      }
    }

    const scored = docs.map((doc, i) => {
      // 从 query 角度打分只考虑 query 包含的 token
      const queryWords = queryTokenInfo.map((t) => t.word);
      const docTokens = docTokensList[i];

      // 只对 query 中出现的词做 BM25 计算
      const queryWordsSet = new Set(queryWords);
      const relevantDocTokens = docTokens.filter((t) => queryWordsSet.has(t.word));
      
      // 如果 doc 没有命中任何 query 词，分数为 0
      if (relevantDocTokens.length === 0) {
        return {
          entry: {
            id: doc.id,
            text: doc.text,
            embedding: doc.embedding,
            source: doc.source,
            weight: doc.weight,
            createdAt: doc.createdAt,
            lastRecalledAt: doc.lastRecalledAt,
            metadata: doc.metadata,
          },
          score: 0,
        };
      }

      return {
        entry: {
          id: doc.id,
          text: doc.text,
          embedding: doc.embedding,
          source: doc.source,
          weight: doc.weight,
          createdAt: doc.createdAt,
          lastRecalledAt: doc.lastRecalledAt,
          metadata: doc.metadata,
        },
        score: bm25Score(queryTokenInfo, docTokens, docFreq, totalDocs, avgDocLen),
      };
    });

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  }
}
