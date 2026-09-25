export type EarlyTtsPlaybackResult = "completed" | "skipped" | "interrupted" | "error";
export type EarlyTtsPlay = (segment: string, index: number) => Promise<EarlyTtsPlaybackResult>;
/** 自动语音早播的文本切分模式：sentence=一句一切（默认）；paragraph=一段一切（仅空行段落切分）；off=不切分（收完整条再整段朗读）。 */
export type EarlyTtsSplitMode = "sentence" | "paragraph" | "off";

/** 把设置层的「开关+模式」换算为队列实际切分模式：开关关闭则整段朗读；否则按 mode 选择，非法值一律回退一句一切。 */
export function resolveEarlyTtsSplitMode(
  enabled: unknown,
  mode: unknown,
): EarlyTtsSplitMode {
  if (enabled === false) return "off";
  if (mode === "paragraph") return "paragraph";
  return "sentence";
}

const SENTENCE_END = /[。！？!?；;]/;

function codePointLength(text: string): number {
  return Array.from(text).length;
}

function hasOpenGfmTableTail(candidate: string): boolean {
  const lines = candidate.trimEnd().split(/\r?\n/);
  let blockStart = lines.length - 1;
  while (blockStart > 0 && lines[blockStart - 1].trim()) blockStart -= 1;
  const block = lines.slice(blockStart);
  if (block.length < 2 || !block[0].includes("|")) return false;
  return /^\s*\|?\s*:?-{1,}:?\s*(?:\|\s*:?-{1,}:?\s*)+\|?\s*$/.test(block[1]);
}

interface ScanState {
  fenceChar: "`" | "~" | null;
  fenceLength: number;
  inlineCodeLength: number;
  math: "$" | "$$" | "\\(" | "\\[" | null;
  linkLabelDepth: number;
  linkDestinationDepth: number;
  angleTag: boolean;
}

/** Incrementally commits only Markdown slices whose sentence and structural delimiters are closed. */
export class StreamingMarkdownSegmenter {
  private buffer = "";
  private committed = 0;

  constructor(
    private readonly minChars = 4,
    private readonly splitMode: EarlyTtsSplitMode = "sentence",
  ) {}

  append(delta: string): string[] {
    if (delta) this.buffer += delta;
    // off 模式流式中途不切分：提前返回，省去对已累积文本的全量重扫
    if (this.splitMode === "off") return [];
    return this.scan(false);
  }

  finish(fullText?: string): string[] {
    if (fullText && fullText.startsWith(this.buffer)) this.buffer += fullText.slice(this.buffer.length);
    return this.scan(true);
  }

  /** 丢弃未提交的切分缓冲（轮次候选降级时用）：后续 append 从零开始，不影响已提交的句子。 */
  reset(): void {
    this.buffer = "";
    this.committed = 0;
  }

  private scan(final: boolean): string[] {
    const segments: string[] = [];
    let segmentStart = this.committed;
    const state: ScanState = {
      fenceChar: null,
      fenceLength: 0,
      inlineCodeLength: 0,
      math: null,
      linkLabelDepth: 0,
      linkDestinationDepth: 0,
      angleTag: false,
    };

    const commit = (end: number, allowTable: boolean) => {
      const candidate = this.buffer.slice(segmentStart, end).trim();
      if (!candidate) return;
      // 仅流式中途以最小长度防碎；收尾提交完整剩余文本时不受此限
      if (!final && codePointLength(candidate) < this.minChars) return;
      if (!allowTable && hasOpenGfmTableTail(candidate)) return;
      segments.push(candidate);
      segmentStart = end;
      this.committed = end;
    };

    for (let index = segmentStart; index < this.buffer.length; index += 1) {
      const atLineStart = index === 0 || this.buffer[index - 1] === "\n";
      if (atLineStart && state.inlineCodeLength === 0 && state.math === null) {
        const fence = /^( {0,3})(`{3,}|~{3,})/.exec(this.buffer.slice(index));
        if (fence) {
          const marker = fence[2];
          if (!state.fenceChar) {
            state.fenceChar = marker[0] as "`" | "~";
            state.fenceLength = marker.length;
          } else if (marker[0] === state.fenceChar && marker.length >= state.fenceLength) {
            state.fenceChar = null;
            state.fenceLength = 0;
          }
          index += fence[0].length - 1;
          continue;
        }
      }
      if (state.fenceChar) continue;

      const character = this.buffer[index];
      const next = this.buffer[index + 1];
      const escaped = index > 0 && this.buffer[index - 1] === "\\";

      if (character === "`" && !escaped && state.math === null) {
        let runLength = 1;
        while (this.buffer[index + runLength] === "`") runLength += 1;
        if (state.inlineCodeLength === 0) state.inlineCodeLength = runLength;
        else if (runLength === state.inlineCodeLength) state.inlineCodeLength = 0;
        index += runLength - 1;
        continue;
      }
      if (state.inlineCodeLength > 0) continue;

      if (!escaped && character === "$" && next === "$") {
        if (state.math === null) state.math = "$$";
        else if (state.math === "$$") state.math = null;
        index += 1;
        continue;
      }
      if (!escaped && character === "$" && state.math !== "$$") {
        state.math = state.math === "$" ? null : "$";
        continue;
      }
      if (character === "\\" && (next === "(" || next === "[")) {
        if (state.math === null) state.math = next === "(" ? "\\(" : "\\[";
        index += 1;
        continue;
      }
      if (
        character === "\\"
        && ((next === ")" && state.math === "\\(") || (next === "]" && state.math === "\\["))
      ) {
        state.math = null;
        index += 1;
        continue;
      }
      if (state.math) continue;

      if (state.angleTag) {
        if (character === ">") state.angleTag = false;
        continue;
      }
      if (character === "<") {
        state.angleTag = true;
        continue;
      }
      if (state.linkDestinationDepth > 0) {
        if (character === "(") state.linkDestinationDepth += 1;
        else if (character === ")") state.linkDestinationDepth -= 1;
        continue;
      }
      if (state.linkLabelDepth > 0) {
        if (character === "[") state.linkLabelDepth += 1;
        else if (character === "]") {
          state.linkLabelDepth -= 1;
          if (state.linkLabelDepth === 0 && next === "(") {
            state.linkDestinationDepth = 1;
            index += 1;
          }
        }
        continue;
      }
      if (character === "[") {
        state.linkLabelDepth = 1;
        continue;
      }
      if (this.buffer.startsWith("https://", index) || this.buffer.startsWith("http://", index)) {
        let urlEnd = index;
        while (urlEnd < this.buffer.length && !/[\s<>。！？；，、]/.test(this.buffer[urlEnd])) urlEnd += 1;
        index = Math.max(index, urlEnd - 1);
        continue;
      }

      if (SENTENCE_END.test(character)) {
        if (this.splitMode === "sentence") commit(index + 1, false);
        continue;
      }
      if (character === "\n" && next === "\n") {
        if (this.splitMode !== "off") commit(index + 1, true);
      }
    }

    const structuresClosed = !state.fenceChar
      && state.inlineCodeLength === 0
      && state.math === null
      && state.linkLabelDepth === 0
      && state.linkDestinationDepth === 0
      && !state.angleTag;
    if (final) {
      // off 模式不做任何中途切分：收尾时无论结构是否闭合都整段提交，
      // 避免因末尾残留未闭合 Markdown 结构把整条回复丢弃。
      if (this.splitMode === "off") commit(this.buffer.length, true);
      else if (structuresClosed) commit(this.buffer.length, true);
    }
    return segments;
  }
}

/** Serializes complete speech segments so a later sentence never interrupts the current audio. */
export class EarlyTtsPlaybackQueue {
  private readonly segmenter: StreamingMarkdownSegmenter;
  private readonly pending: string[] = [];
  private drainPromise: Promise<void> | null = null;
  private cancelled = false;
  private finished = false;
  private generation = 0;
  private segmentIndex = 0;
  private cancelNotified = false;

  constructor(
    private readonly play: EarlyTtsPlay,
    private readonly cancelPlayback: () => void = () => undefined,
    splitMode: EarlyTtsSplitMode = "sentence",
  ) {
    this.segmenter = new StreamingMarkdownSegmenter(4, splitMode);
  }

  append(delta: string): void {
    if (this.cancelled || this.finished) return;
    this.enqueue(this.segmenter.append(delta));
  }

  async finish(fullText: string): Promise<void> {
    if (!this.cancelled && !this.finished) {
      this.finished = true;
      this.enqueue(this.segmenter.finish(fullText));
    }
    while (this.drainPromise) await this.drainPromise;
  }

  cancel(): void {
    this.cancelled = true;
    this.generation += 1;
    this.pending.length = 0;
    if (!this.cancelNotified) {
      this.cancelNotified = true;
      this.cancelPlayback();
    }
  }

  isCancelled(): boolean {
    return this.cancelled;
  }

  /**
   * 轮次候选正文降级为过程消息时调用：
   * 丢弃已切出但尚未播放的句子与半句缓冲，正在播放的句子不打断，
   * 队列保持可用，下一轮流式文本可继续 append。
   */
  dropPending(): void {
    if (this.cancelled) return;
    this.pending.length = 0;
    this.segmenter.reset();
  }

  private enqueue(segments: string[]): void {
    if (segments.length === 0 || this.cancelled) return;
    this.pending.push(...segments);
    this.scheduleDrain();
  }

  private scheduleDrain(): void {
    if (this.drainPromise || this.cancelled || this.pending.length === 0) return;
    const generation = this.generation;
    const running = this.drain(generation);
    this.drainPromise = running;
    void running.finally(() => {
      if (this.drainPromise === running) this.drainPromise = null;
      if (generation === this.generation && this.pending.length > 0 && !this.cancelled) this.scheduleDrain();
    });
  }

  private async drain(generation: number): Promise<void> {
    while (this.pending.length > 0 && !this.cancelled && generation === this.generation) {
      const segment = this.pending.shift()!;
      const result = await this.play(segment, this.segmentIndex++);
      if (generation !== this.generation || this.cancelled) return;
      if (result !== "completed") {
        this.cancelled = true;
        this.pending.length = 0;
        return;
      }
    }
  }
}
