// 通用 TTL 结果缓存：同一 key 的成功结果在有效期内直接复用。
// 设计取向是"简单可靠"：
// - 固定 TTL，不做命中续期——时效类内容（新闻/股价）不应因频繁访问而一直保鲜
// - 超过容量上限时整体清空，不搞 LRU——百条规模内淘汰算法的复杂度不值得
// - 只缓存成功结果：失败/报错由调用方自行决定不写入，避免网络抖动被缓存放大

interface CacheEntry<T> {
  value: T;
  /** 写入时间（毫秒时间戳），命中时透出给消费方标注信息新鲜度 */
  at: number;
}

export class TtlResultCache<T> {
  private entries = new Map<string, CacheEntry<T>>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries = 100,
  ) {}

  /** 查缓存：命中且未过期返回条目，否则返回 null（过期条目顺手删掉） */
  get(key: string): CacheEntry<T> | null {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (Date.now() - entry.at >= this.ttlMs) {
      this.entries.delete(key);
      return null;
    }
    return entry;
  }

  /** 写缓存：只在拿到成功结果后调用；超过容量上限时整体清空 */
  set(key: string, value: T): void {
    if (this.entries.size >= this.maxEntries) {
      this.entries.clear();
    }
    this.entries.set(key, { value, at: Date.now() });
  }

  /** 清空全部缓存（测试隔离用） */
  clear(): void {
    this.entries.clear();
  }
}
