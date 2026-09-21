// 反应队列测试：持久化与重启恢复、去重键语义、single-flight 防重入、
// 决策幂等（resolvedDecision 先落盘再执行）、三类失败分类退避、
// 深夜窗口与长尾延迟分桶的大样本统计。
import fs from "fs";
import os from "os";
import path from "path";
import { describe, expect, it, vi } from "vitest";
import {
  applyNightWindow,
  computeCharacterPostDelayMs,
  computeCharacterReplyDelayMs,
  computeCyrenePostDelayMs,
  computeCyreneReplyDelayMs,
  createReactionQueue,
  type ReactionDecideOutcome,
  type ReactionQueue,
  type ReactionTaskExecutor,
} from "./reaction-queue";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function tempQueueFile(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-reaction-queue-")), "moments-reaction-queue.json");
}

/** 可复现的线性同余随机源：分桶统计与边界断言都需要稳定序列 */
function createSeededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

interface ExecutorHarness {
  executor: ReactionTaskExecutor;
  decide: ReturnType<typeof vi.fn>;
  apply: ReturnType<typeof vi.fn>;
}

/** 默认执行器：decide 产出 silent、apply 正常完成；按用例覆盖行为 */
function makeExecutor(
  overrides: {
    decide?: (task: unknown) => Promise<ReactionDecideOutcome>;
    apply?: (task: unknown, decision: unknown) => Promise<void>;
  } = {},
): ExecutorHarness {
  const decide = vi.fn(
    overrides.decide ?? (async (): Promise<ReactionDecideOutcome> => ({ type: "decided", decision: { action: "silent" } })),
  );
  const apply = vi.fn(overrides.apply ?? (async () => undefined));
  return { executor: { decide, apply }, decide, apply };
}

interface QueueHarness extends ExecutorHarness {
  queue: ReactionQueue;
  /** 推进可控时钟并扫描一轮 */
  advanceAndDrain(ms: number): Promise<boolean>;
}

/** 可控时钟的队列 harness：dueAt 比较与退避推进都不依赖真实时间 */
function makeQueue(options: {
  executor?: ExecutorHarness;
  filePath?: string;
  now?: number;
} = {}): QueueHarness {
  const clock = { now: options.now ?? 1_000_000 };
  const harness = options.executor ?? makeExecutor();
  const queue = createReactionQueue({
    filePath: options.filePath ?? tempQueueFile(),
    executor: harness.executor,
    now: () => clock.now,
  });
  return {
    ...harness,
    queue,
    async advanceAndDrain(ms: number) {
      clock.now += ms;
      return queue.drainOnce();
    },
  };
}

describe("反应队列持久化与执行", () => {
  it("入队即落盘，重启后从磁盘恢复未完成任务", () => {
    const filePath = tempQueueFile();
    const first = makeQueue({ filePath, now: 5_000 });
    const task = first.queue.enqueue({ kind: "post_eval", actor: "万敌", postId: "p1", dueAt: 999_999 })!;

    // 文件里已有任务（入队即落盘）
    const onDisk = JSON.parse(fs.readFileSync(filePath, "utf8")) as { tasks: unknown[] };
    expect(onDisk.tasks).toHaveLength(1);

    // 新队列实例（模拟重启）从磁盘恢复
    const second = makeQueue({ filePath, now: 5_000 });
    expect(second.queue.list()).toEqual([task]);
  });

  it("到期任务按 dueAt 顺序执行，成功后从队列与磁盘删除", async () => {
    const filePath = tempQueueFile();
    const now = 1_000_000;
    const h = makeQueue({ filePath, now });
    // 两条都已逾期：早逾期的（200ms 前）必须先于晚逾期的（100ms 前）执行
    const recent = h.queue.enqueue({ kind: "post_eval", actor: "万敌", postId: "p1", dueAt: now - 100 })!;
    const overdue = h.queue.enqueue({ kind: "post_eval", actor: "风堇", postId: "p2", dueAt: now - 200 })!;

    await h.queue.drainOnce();

    expect(h.decide.mock.invocationCallOrder[0]).toBeLessThan(h.decide.mock.invocationCallOrder[1]);
    expect(h.decide).toHaveBeenCalledTimes(2);
    expect(h.queue.list()).toEqual([]);
    // 执行顺序与入队顺序无关，只看 dueAt
    const executedIds = h.decide.mock.calls.map(([task]) => (task as { id: string }).id);
    expect(executedIds).toEqual([overdue.id, recent.id]);
    // 磁盘同步清空
    const onDisk = JSON.parse(fs.readFileSync(filePath, "utf8")) as { tasks: unknown[] };
    expect(onDisk.tasks).toEqual([]);
  });

  it("未到期任务不执行", async () => {
    const h = makeQueue({ now: 0 });
    h.queue.enqueue({ kind: "post_eval", actor: "万敌", postId: "p1", dueAt: 60_000 });

    await h.queue.drainOnce();

    expect(h.decide).not.toHaveBeenCalled();
    expect(h.queue.list()).toHaveLength(1);
  });

  it("去重键区分 post / reply+triggerCommentId / like 三种语义", () => {
    const h = makeQueue();

    // 同 actor 同动态的 post_eval 只入队一次
    expect(h.queue.enqueue({ kind: "post_eval", actor: "万敌", postId: "p1" })).not.toBeNull();
    expect(h.queue.enqueue({ kind: "post_eval", actor: "万敌", postId: "p1" })).toBeNull();
    // 动态不同不去重
    expect(h.queue.enqueue({ kind: "post_eval", actor: "万敌", postId: "p2" })).not.toBeNull();
    // auto_like 与 post_eval 语义不同，互不去重
    expect(h.queue.enqueue({ kind: "auto_like", actor: "万敌", postId: "p1" })).not.toBeNull();
    // reply_eval 以 triggerCommentId 区分：不同评论的回复任务都要保留
    expect(h.queue.enqueue({ kind: "reply_eval", actor: "万敌", postId: "p1", triggerCommentId: "c1" })).not.toBeNull();
    expect(h.queue.enqueue({ kind: "reply_eval", actor: "万敌", postId: "p1", triggerCommentId: "c1" })).toBeNull();
    expect(h.queue.enqueue({ kind: "reply_eval", actor: "万敌", postId: "p1", triggerCommentId: "c2" })).not.toBeNull();

    expect(h.queue.list()).toHaveLength(5);
  });

  it("auto_like 不调模型，到期直接落库点赞", async () => {
    const h = makeQueue({ now: 0 });
    h.queue.enqueue({ kind: "auto_like", actor: "遐蝶", postId: "p1", dueAt: 0 });

    await h.queue.drainOnce();

    expect(h.decide).not.toHaveBeenCalled();
    expect(h.apply).toHaveBeenCalledTimes(1);
    const [task, decision] = h.apply.mock.calls[0];
    expect((task as { actor: string }).actor).toBe("遐蝶");
    expect(decision).toEqual({ action: "like" });
    expect(h.queue.list()).toEqual([]);
  });

  it("single-flight：排空进行中时重复扫描直接返回，不并发重执行", async () => {
    let releaseDecide: (() => void) | undefined;
    const decide = vi.fn(
      () => new Promise<ReactionDecideOutcome>((resolve) => {
        releaseDecide = () => resolve({ type: "decided", decision: { action: "silent" } });
      }),
    );
    const apply = vi.fn(async () => undefined);
    const h = makeQueue({ executor: { executor: { decide, apply }, decide, apply }, now: 0 });
    h.queue.enqueue({ kind: "post_eval", actor: "万敌", postId: "p1", dueAt: 0 });

    const first = h.queue.drainOnce();
    // 首轮排空卡在模型调用上：并发扫描必须让位
    await expect(h.queue.drainOnce()).resolves.toBe(false);

    releaseDecide!();
    await expect(first).resolves.toBe(true);
    expect(decide).toHaveBeenCalledTimes(1);
  });

  it("执行器返回 stale（世界已变）时任务被删除", async () => {
    const h = makeQueue({ executor: makeExecutor({ decide: async () => ({ type: "stale", reason: "post_not_found" }) }) });
    h.queue.enqueue({ kind: "post_eval", actor: "万敌", postId: "p1", dueAt: 0 });

    await h.queue.drainOnce();

    expect(h.apply).not.toHaveBeenCalled();
    expect(h.queue.list()).toEqual([]);
  });

  it("队列文件损坏时从空队列开始，不阻断功能", () => {
    const filePath = tempQueueFile();
    fs.writeFileSync(filePath, "不是 JSON", "utf8");

    const h = makeQueue({ filePath });
    expect(h.queue.list()).toEqual([]);
    expect(h.queue.enqueue({ kind: "post_eval", actor: "万敌", postId: "p1" })).not.toBeNull();
  });

  it("start 启动即补扫一轮：重启后已逾期的任务立即续上", async () => {
    const filePath = tempQueueFile();
    const first = makeQueue({ filePath, now: 1_000 });
    first.queue.enqueue({ kind: "post_eval", actor: "万敌", postId: "p1", dueAt: 500 });

    // 模拟重启：新实例从磁盘恢复，start 的首轮补扫不等第一个扫描周期
    const h = makeQueue({ filePath, now: 2_000 });
    h.queue.start();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(h.decide).toHaveBeenCalledTimes(1);
    expect(h.queue.list()).toEqual([]);
    h.queue.stop();
  });
});

describe("决策幂等与失败分类", () => {
  it("决策先落盘再执行：apply 抛错后任务保留，重放时直接执行缓存决策不再调模型", async () => {
    const filePath = tempQueueFile();
    let applyShouldFail = true;
    const executor = makeExecutor({
      decide: async () => ({ type: "decided", decision: { action: "comment", comment: "火候不错。" } }),
      apply: async () => {
        if (applyShouldFail) throw new Error("磁盘写入失败");
      },
    });
    const h = makeQueue({ executor, filePath, now: 0 });
    const task = h.queue.enqueue({ kind: "post_eval", actor: "万敌", postId: "p1", dueAt: 0 })!;

    // 第一轮：决策落盘但副作用失败，任务保留
    await h.queue.drainOnce();
    expect(h.decide).toHaveBeenCalledTimes(1);
    expect(h.apply).toHaveBeenCalledTimes(1);
    const persisted = JSON.parse(fs.readFileSync(filePath, "utf8")) as { tasks: Array<{ id: string; resolvedDecision?: unknown }> };
    expect(persisted.tasks[0].id).toBe(task.id);
    expect(persisted.tasks[0].resolvedDecision).toEqual({ action: "comment", comment: "火候不错。" });

    // 第二轮（模拟重启后重扫）：直接重放缓存决策，不再调模型
    applyShouldFail = false;
    await h.queue.drainOnce();
    expect(h.decide).toHaveBeenCalledTimes(1);
    expect(h.apply).toHaveBeenCalledTimes(2);
    expect(h.queue.list()).toEqual([]);
  });

  it("磁盘上已带 resolvedDecision 的任务（崩溃恢复）直接执行原决策", async () => {
    const filePath = tempQueueFile();
    fs.writeFileSync(filePath, JSON.stringify({
      tasks: [{
        id: "task_recovered",
        kind: "reply_eval",
        actor: "cyrene",
        postId: "p1",
        triggerCommentId: "c9",
        dueAt: 0,
        attempts: 0,
        resolvedDecision: { action: "reply", comment: "收到。" },
      }],
    }), "utf8");

    const h = makeQueue({ filePath, now: 0 });
    await h.queue.drainOnce();

    expect(h.decide).not.toHaveBeenCalled();
    expect(h.apply).toHaveBeenCalledWith(
      expect.objectContaining({ id: "task_recovered" }),
      { action: "reply", comment: "收到。" },
    );
    expect(h.queue.list()).toEqual([]);
  });

  it("模型输出非法：降级 silent 落盘后删任务，不重试不落库", async () => {
    const h = makeQueue({
      executor: makeExecutor({ decide: async () => ({ type: "invalid", reason: "invalid_json" }) }),
    });
    h.queue.enqueue({ kind: "post_eval", actor: "那刻夏", postId: "p1", dueAt: 0 });

    await h.queue.drainOnce();

    expect(h.apply).not.toHaveBeenCalled();
    expect(h.queue.list()).toEqual([]);
  });

  it("供应商失败按 5/15/30 分钟退避，累计三次退避后放弃删任务", async () => {
    const h = makeQueue({
      executor: makeExecutor({ decide: async () => ({ type: "retry", reason: "http_429" }) }),
    });
    h.queue.enqueue({ kind: "post_eval", actor: "万敌", postId: "p1", dueAt: 0 });

    // 第一次失败：退避 5 分钟
    await h.queue.drainOnce();
    let [task] = h.queue.list();
    expect(task.attempts).toBe(1);
    expect(task.dueAt).toBe(1_000_000 + 5 * MINUTE);

    // 5 分钟后重试仍失败：退避 15 分钟
    await h.advanceAndDrain(5 * MINUTE);
    [task] = h.queue.list();
    expect(task.attempts).toBe(2);
    expect(task.dueAt).toBe(1_000_000 + 5 * MINUTE + 15 * MINUTE);

    // 第三次失败：退避 30 分钟
    await h.advanceAndDrain(15 * MINUTE);
    [task] = h.queue.list();
    expect(task.attempts).toBe(3);
    expect(task.dueAt).toBe(1_000_000 + 20 * MINUTE + 30 * MINUTE);

    // 第三次退避耗尽后仍失败：放弃删任务
    await h.advanceAndDrain(30 * MINUTE);
    expect(h.queue.list()).toEqual([]);
    expect(h.decide).toHaveBeenCalledTimes(4);
  });

  it("执行器抛异常按供应商失败处理：退避重试而不是丢弃", async () => {
    const h = makeQueue({
      executor: makeExecutor({ decide: async () => { throw new Error("后台队列炸了"); } }),
    });
    h.queue.enqueue({ kind: "post_eval", actor: "万敌", postId: "p1", dueAt: 0 });

    await h.queue.drainOnce();

    const [task] = h.queue.list();
    expect(task.attempts).toBe(1);
    expect(task.dueAt).toBe(1_000_000 + 5 * MINUTE);
  });
});

describe("深夜窗口", () => {
  it("凌晨 1~7 点入队：dueAt 替换为当日 08:00 + 0~120 分钟", () => {
    const night = new Date("2026-09-06T03:30:00");
    const morningEight = new Date("2026-09-06T08:00:00").getTime();

    // random=0 → 恰好 08:00；random 接近 1 → 不超过 10:00
    expect(applyNightWindow(morningEight, night, () => 0)).toBe(morningEight);
    const spread = applyNightWindow(morningEight, night, () => 0.999);
    expect(spread).toBeGreaterThan(morningEight);
    expect(spread).toBeLessThanOrEqual(morningEight + 120 * MINUTE);

    // 正常延迟无论多长都被直接替代（不叠加）
    expect(applyNightWindow(night.getTime() + 4 * HOUR, night, () => 0)).toBe(morningEight);
  });

  it("白天与午夜前（00:30）入队不受深夜窗口影响", () => {
    const day = new Date("2026-09-06T14:00:00");
    const dueAt = day.getTime() + 40 * MINUTE;
    expect(applyNightWindow(dueAt, day, () => 0.5)).toBe(dueAt);

    const beforeWindow = new Date("2026-09-06T00:30:00");
    const dueAt2 = beforeWindow.getTime() + 40 * MINUTE;
    expect(applyNightWindow(dueAt2, beforeWindow, () => 0.5)).toBe(dueAt2);
  });
});

describe("长尾延迟分桶", () => {
  const SAMPLES = 100_000;

  /** 统计延迟落进各桶的占比，容差 ±2% */
  function bucketRatios(delays: number[], boundaries: number[]): number[] {
    const counts = new Array<number>(boundaries.length + 1).fill(0);
    for (const delay of delays) {
      let bucket = boundaries.length;
      for (let i = 0; i < boundaries.length; i++) {
        if (delay < boundaries[i]) { bucket = i; break; }
      }
      counts[bucket] += 1;
    }
    return counts.map((count) => count / delays.length);
  }

  // 10 万样本的统计压测在 CI 的 4 核 runner 上可能超过默认 5s，
  // 超时会导致 vitest 杀掉整个 fork worker（波及同 worker 的其他文件）
  it("角色表态延迟：桶占比约 50/30/15/5，延迟在 3 分钟 ~ 4 小时内", { timeout: 60_000 }, () => {
    const random = createSeededRandom(42);
    const delays = Array.from({ length: SAMPLES }, () => computeCharacterPostDelayMs(random));

    for (const delay of delays) {
      expect(delay).toBeGreaterThanOrEqual(3 * MINUTE);
      expect(delay).toBeLessThan(4 * HOUR);
    }
    const ratios = bucketRatios(delays, [20 * MINUTE, 60 * MINUTE, 2 * HOUR]);
    expect(ratios[0]).toBeGreaterThan(0.48);
    expect(ratios[0]).toBeLessThan(0.52);
    expect(ratios[1]).toBeGreaterThan(0.28);
    expect(ratios[1]).toBeLessThan(0.32);
    expect(ratios[2]).toBeGreaterThan(0.13);
    expect(ratios[2]).toBeLessThan(0.17);
    expect(ratios[3]).toBeGreaterThan(0.03);
    expect(ratios[3]).toBeLessThan(0.07);
  });

  it("角色回复延迟：桶占比约 50/30/20，延迟在 5 ~ 60 分钟内", { timeout: 60_000 }, () => {
    const random = createSeededRandom(7);
    const delays = Array.from({ length: SAMPLES }, () => computeCharacterReplyDelayMs(random));

    for (const delay of delays) {
      expect(delay).toBeGreaterThanOrEqual(5 * MINUTE);
      expect(delay).toBeLessThan(60 * MINUTE);
    }
    const ratios = bucketRatios(delays, [15 * MINUTE, 40 * MINUTE]);
    expect(ratios[0]).toBeGreaterThan(0.48);
    expect(ratios[0]).toBeLessThan(0.52);
    expect(ratios[1]).toBeGreaterThan(0.28);
    expect(ratios[1]).toBeLessThan(0.32);
    expect(ratios[2]).toBeGreaterThan(0.18);
    expect(ratios[2]).toBeLessThan(0.22);
  });

  it("昔涟在线：表态 1~8 分钟、回复 1~5 分钟", { timeout: 30_000 }, () => {
    const random = createSeededRandom(99);
    for (let i = 0; i < 10_000; i++) {
      const post = computeCyrenePostDelayMs(true, random);
      const reply = computeCyreneReplyDelayMs(true, random);
      expect(post).toBeGreaterThanOrEqual(MINUTE);
      expect(post).toBeLessThan(8 * MINUTE);
      expect(reply).toBeGreaterThanOrEqual(MINUTE);
      expect(reply).toBeLessThan(5 * MINUTE);
    }
  });

  it("昔涟离线：表态与回复都落在 1~40 分钟，回复整体比表态偏快", { timeout: 30_000 }, () => {
    const random = createSeededRandom(1234);
    const posts: number[] = [];
    const replies: number[] = [];
    for (let i = 0; i < 10_000; i++) {
      posts.push(computeCyrenePostDelayMs(false, random));
      replies.push(computeCyreneReplyDelayMs(false, random));
    }
    expect(Math.min(...posts)).toBeGreaterThanOrEqual(MINUTE);
    expect(Math.max(...posts)).toBeLessThan(40 * MINUTE);
    expect(Math.min(...replies)).toBeGreaterThanOrEqual(MINUTE);
    expect(Math.max(...replies)).toBeLessThan(40 * MINUTE);
    // 四个桶都有样本（长尾桶不被随机种子意外跳过）
    expect(bucketRatios(posts, [10 * MINUTE, 25 * MINUTE, 35 * MINUTE]).every((ratio) => ratio > 0.02)).toBe(true);
    expect(bucketRatios(replies, [8 * MINUTE, 20 * MINUTE, 32 * MINUTE]).every((ratio) => ratio > 0.02)).toBe(true);
    // 回复中位数快于表态中位数：被回复后她会优先接话
    const median = (values: number[]) => values.slice().sort((a, b) => a - b)[Math.floor(values.length / 2)];
    expect(median(replies)).toBeLessThan(median(posts));
  });
});
