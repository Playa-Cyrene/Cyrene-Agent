import { describe, expect, it, vi } from "vitest";
import {
  EarlyTtsPlaybackQueue,
  StreamingMarkdownSegmenter,
  resolveEarlyTtsSplitMode,
} from "./early-tts-queue";

describe("StreamingMarkdownSegmenter", () => {
  it("emits each complete sentence once across token-like chunks", () => {
    const segmenter = new StreamingMarkdownSegmenter();
    expect(segmenter.append("昔涟在这里")).toEqual([]);
    expect(segmenter.append("陪着你。下一句还")).toEqual(["昔涟在这里陪着你。"]);
    expect(segmenter.append("没有结束")).toEqual([]);
    expect(segmenter.append("呢！")).toEqual(["下一句还没有结束呢！"]);
    expect(segmenter.finish("昔涟在这里陪着你。下一句还没有结束呢！")).toEqual([]);
  });

  it("waits for fenced code blocks to close", () => {
    const segmenter = new StreamingMarkdownSegmenter();
    expect(segmenter.append("这里有代码：\n```ts\nconst value = 1;\n")).toEqual([]);
    expect(segmenter.append("```\n\n然后继续。"))
      .toEqual(["这里有代码：\n```ts\nconst value = 1;\n```", "然后继续。"]);
  });

  it("waits for inline and block Latex delimiters to close", () => {
    const segmenter = new StreamingMarkdownSegmenter();
    expect(segmenter.append("公式为 $\\frac{a")).toEqual([]);
    expect(segmenter.append("}{b}$。"))
      .toEqual(["公式为 $\\frac{a}{b}$。"]);

    const block = new StreamingMarkdownSegmenter();
    expect(block.append("$$\\int_0^1 x dx")).toEqual([]);
    expect(block.append("$$\n\n结论成立。"))
      .toEqual(["$$\\int_0^1 x dx$$", "结论成立。"]);
  });

  it("does not submit a GFM table until its block is closed", () => {
    const segmenter = new StreamingMarkdownSegmenter();
    expect(segmenter.append("|姓名|分数|\n|-|-|\n|昔涟|100|\n")).toEqual([]);
    expect(segmenter.append("|伙伴|99|\n\n"))
      .toEqual(["|姓名|分数|\n|-|-|\n|昔涟|100|\n|伙伴|99|"]);
  });

  it("does not split on punctuation inside links or bare URLs", () => {
    const segmenter = new StreamingMarkdownSegmenter();
    expect(segmenter.append("请打开 [有什么问题？](https://example.com/search?q=cyrene) 查看。"))
      .toEqual(["请打开 [有什么问题？](https://example.com/search?q=cyrene) 查看。"]);
    expect(segmenter.append("再看 https://example.com/search?q=tts&lang=zh。"))
      .toEqual(["再看 https://example.com/search?q=tts&lang=zh。"]);
  });

  it("flushes a closed final tail but not an unclosed structure", () => {
    const segmenter = new StreamingMarkdownSegmenter();
    segmenter.append("最后没有句号");
    expect(segmenter.finish("最后没有句号")).toEqual(["最后没有句号"]);

    const unclosed = new StreamingMarkdownSegmenter();
    unclosed.append("```ts\nconst value = 1");
    expect(unclosed.finish("```ts\nconst value = 1")).toEqual([]);
  });

  it("paragraph mode splits only on blank lines, never mid-sentence", () => {
    const segmenter = new StreamingMarkdownSegmenter(4, "paragraph");
    expect(segmenter.append("第一段没有句号也")).toEqual([]);
    expect(segmenter.append("不会切。\n\n第二段开始。还在第")).toEqual(["第一段没有句号也不会切。"]);
    expect(segmenter.append("二段。\n\n第三段完。")).toEqual(["第二段开始。还在第二段。"]);
    expect(segmenter.finish("第一段没有句号也不会切。\n\n第二段开始。还在第二段。\n\n第三段完。"))
      .toEqual(["第三段完。"]);
  });

  it("paragraph mode still waits for fenced code blocks to close", () => {
    const segmenter = new StreamingMarkdownSegmenter(4, "paragraph");
    expect(segmenter.append("代码：\n```ts\nconst x = 1;\n")).toEqual([]);
    expect(segmenter.append("```\n\n下一段话开始。\n\n这里是结尾。"))
      .toEqual(["代码：\n```ts\nconst x = 1;\n```", "下一段话开始。"]);
    expect(segmenter.finish("代码：\n```ts\nconst x = 1;\n```\n\n下一段话开始。\n\n这里是结尾。"))
      .toEqual(["这里是结尾。"]);
  });

  it("off mode never splits mid-stream and emits the whole reply on finish", () => {
    const segmenter = new StreamingMarkdownSegmenter(4, "off");
    expect(segmenter.append("第一句。第二句。还没\n\n第三段。")).toEqual([]);
    expect(segmenter.finish("第一句。第二句。还没\n\n第三段。"))
      .toEqual(["第一句。第二句。还没\n\n第三段。"]);
  });

  it("off mode still commits the reply when trailing markdown is unclosed", () => {
    const segmenter = new StreamingMarkdownSegmenter(4, "off");
    segmenter.append("```ts\nconst value = 1");
    expect(segmenter.finish("```ts\nconst value = 1")).toEqual(["```ts\nconst value = 1"]);
  });

  it("sentence mode commits a short complete reply on finish, not during append", () => {
    const segmenter = new StreamingMarkdownSegmenter(4, "sentence");
    expect(segmenter.append("好的。")).toEqual([]);
    expect(segmenter.finish("好的。")).toEqual(["好的。"]);
  });

  it("paragraph mode commits a short reply on finish", () => {
    const segmenter = new StreamingMarkdownSegmenter(4, "paragraph");
    expect(segmenter.append("好")).toEqual([]);
    expect(segmenter.finish("好")).toEqual(["好"]);
  });

  it("off mode commits short replies on finish and never mid-stream", () => {
    const one = new StreamingMarkdownSegmenter(4, "off");
    expect(one.append("好")).toEqual([]);
    expect(one.finish("好")).toEqual(["好"]);

    const two = new StreamingMarkdownSegmenter(4, "off");
    expect(two.append("嗯？")).toEqual([]);
    expect(two.finish("嗯？")).toEqual(["嗯？"]);
  });

  it("reset 丢弃未提交缓冲：下一轮 append 从零开始切分", () => {
    const segmenter = new StreamingMarkdownSegmenter();
    expect(segmenter.append("第一句完成。")).toEqual(["第一句完成。"]);
    segmenter.append("半句没有结尾");
    segmenter.reset();
    expect(segmenter.append("新一句完成。")).toEqual(["新一句完成。"]);
    expect(segmenter.finish("新一句完成。")).toEqual([]);
  });
});

describe("EarlyTtsPlaybackQueue", () => {
  it("plays queued sentences strictly one at a time", async () => {
    let finishFirst!: () => void;
    const first = new Promise<"completed">((resolve) => { finishFirst = () => resolve("completed"); });
    const play = vi.fn()
      .mockImplementationOnce(() => first)
      .mockResolvedValueOnce("completed");
    const queue = new EarlyTtsPlaybackQueue(play);

    queue.append("第一句话完成了。第二句话也完成了。 ");
    await Promise.resolve();
    expect(play).toHaveBeenCalledTimes(1);
    finishFirst();
    await queue.finish("第一句话完成了。第二句话也完成了。 ");
    expect(play).toHaveBeenCalledTimes(2);
  });

  it("cancels remaining segments when playback is interrupted", async () => {
    const play = vi.fn().mockResolvedValue("interrupted");
    const cancelPlayback = vi.fn();
    const queue = new EarlyTtsPlaybackQueue(play, cancelPlayback);
    queue.append("第一句话完成了。第二句话也完成了。 ");
    await queue.finish("第一句话完成了。第二句话也完成了。 ");
    expect(play).toHaveBeenCalledTimes(1);
    expect(queue.isCancelled()).toBe(true);
    queue.cancel();
    expect(cancelPlayback).toHaveBeenCalledOnce();
  });

  it("allows finish cleanup after an in-flight item is cancelled", async () => {
    let resolvePlayback!: () => void;
    const play = vi.fn(() => new Promise<"interrupted">((resolve) => {
      resolvePlayback = () => resolve("interrupted");
    }));
    const queue = new EarlyTtsPlaybackQueue(play);
    queue.append("正在播放的第一句话。后面还有一句话。 ");
    await Promise.resolve();
    queue.cancel();
    const finished = queue.finish("正在播放的第一句话。后面还有一句话。 ");
    resolvePlayback();
    await expect(finished).resolves.toBeUndefined();
    expect(play).toHaveBeenCalledTimes(1);
  });

  it("queue applies paragraph mode through its constructor", async () => {
    const play = vi.fn().mockResolvedValue("completed");
    const queue = new EarlyTtsPlaybackQueue(play, undefined, "paragraph");
    queue.append("没有句号的段落一。还没切\n\n段落二开始。");
    await queue.finish("没有句号的段落一。还没切\n\n段落二开始。");
    expect(play).toHaveBeenCalledTimes(2);
    expect(play.mock.calls[0][0]).toBe("没有句号的段落一。还没切");
    expect(play.mock.calls[1][0]).toBe("段落二开始。");
  });

  it("queue in off mode plays the entire reply once on finish", async () => {
    const play = vi.fn().mockResolvedValue("completed");
    const queue = new EarlyTtsPlaybackQueue(play, undefined, "off");
    queue.append("第一句。第二句。还没\n\n第三段。");
    await queue.finish("第一句。第二句。还没\n\n第三段。");
    expect(play).toHaveBeenCalledTimes(1);
    expect(play.mock.calls[0][0]).toBe("第一句。第二句。还没\n\n第三段。");
  });

  it("queue in off mode plays a short reply exactly once on finish", async () => {
    const play = vi.fn().mockResolvedValue("completed");
    const queue = new EarlyTtsPlaybackQueue(play, undefined, "off");
    queue.append("好");
    await queue.finish("好");
    expect(play).toHaveBeenCalledTimes(1);
    expect(play.mock.calls[0][0]).toBe("好");
  });

  it("dropPending 丢弃已切未播句子与半句缓冲：正在播的不打断，下一轮从零开始", async () => {
    let finishFirst!: () => void;
    const first = new Promise<"completed">((resolve) => { finishFirst = () => resolve("completed"); });
    const play = vi.fn()
      .mockImplementationOnce(() => first)
      .mockResolvedValue("completed");
    const queue = new EarlyTtsPlaybackQueue(play);

    // 第一句切出并开始播放（挂起），第二句已切待播，"还有半句"留在缓冲
    queue.append("第一句完整了。第二句完整了。还有半句");
    await Promise.resolve();
    expect(play).toHaveBeenCalledTimes(1);

    // 轮次降级：第二句（未播）与半句缓冲被丢弃，正在播的第一句不受影响
    queue.dropPending();
    finishFirst();
    await Promise.resolve();

    // 下一轮正文从零切分：不会拼接被丢弃的半句
    queue.append("新一句完整了。");
    await queue.finish("新一句完整了。");
    expect(play).toHaveBeenCalledTimes(2);
    expect(play).toHaveBeenNthCalledWith(1, "第一句完整了。", 0);
    expect(play).toHaveBeenNthCalledWith(2, "新一句完整了。", 1);
    expect(queue.isCancelled()).toBe(false);
  });
});

describe("resolveEarlyTtsSplitMode", () => {
  it("maps a disabled switch to off regardless of the chosen mode", () => {
    expect(resolveEarlyTtsSplitMode(false, "sentence")).toBe("off");
    expect(resolveEarlyTtsSplitMode(false, "paragraph")).toBe("off");
    expect(resolveEarlyTtsSplitMode(false, undefined)).toBe("off");
  });

  it("falls back to sentence when the switch is enabled or missing", () => {
    expect(resolveEarlyTtsSplitMode(true, "sentence")).toBe("sentence");
    expect(resolveEarlyTtsSplitMode(undefined, "sentence")).toBe("sentence");
    expect(resolveEarlyTtsSplitMode(true, undefined)).toBe("sentence");
    expect(resolveEarlyTtsSplitMode(undefined, undefined)).toBe("sentence");
  });

  it("ignores an invalid mode instead of guessing", () => {
    expect(resolveEarlyTtsSplitMode(true, "bogus")).toBe("sentence");
    expect(resolveEarlyTtsSplitMode(undefined, "bogus")).toBe("sentence");
  });

  it("keeps paragraph only when explicitly selected", () => {
    expect(resolveEarlyTtsSplitMode(true, "paragraph")).toBe("paragraph");
    expect(resolveEarlyTtsSplitMode(undefined, "paragraph")).toBe("paragraph");
  });
});
