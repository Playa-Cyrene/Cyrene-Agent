/**
 * Work/Learn/Code 会先完整接收并分类模型回合，再把公开文本做展示层渐显。
 * 这不是伪造 reasoning；只改变已经收到的公开文本的呈现节奏。
 */
// 每个公开文本回合最多触发 24 次 React 更新：足够保留渐显感，避免长段落重复重渲染 Markdown。
export function splitTextForReveal(text: string, maxFrames = 24): string[] {
  const graphemes = splitGraphemes(text);
  if (graphemes.length === 0) return [];
  const frameCount = Math.max(1, Math.min(maxFrames, graphemes.length));
  const chunkSize = Math.ceil(graphemes.length / frameCount);
  const chunks: string[] = [];
  for (let index = 0; index < graphemes.length; index += chunkSize) {
    chunks.push(graphemes.slice(index, index + chunkSize).join(""));
  }
  return chunks;
}

export function splitGraphemes(text: string): string[] {
  const Segmenter = (Intl as typeof Intl & {
    Segmenter?: new (
      locales?: string | string[],
      options?: { granularity: "grapheme" },
    ) => { segment: (value: string) => Iterable<{ segment: string }> };
  }).Segmenter;
  if (!Segmenter) return Array.from(text);
  return Array.from(new Segmenter(undefined, { granularity: "grapheme" }).segment(text), ({ segment }) => segment);
}

export const SMOOTH_REVEAL_TICK_MS = 40;

interface SmoothTextRevealOptions {
  baseRate: number;
  maxRate: number;
  initialGroupSize: number;
  maxGroupSize: number;
  accelerationMs: number;
  decelerationMs: number;
}

const DEFAULT_SMOOTH_REVEAL_OPTIONS: SmoothTextRevealOptions = {
  baseRate: 75,
  maxRate: 220,
  initialGroupSize: 3,
  maxGroupSize: 9,
  accelerationMs: 180,
  decelerationMs: 300,
};

/**
 * 只负责已收到文本的展示节奏：首组立即返回，后续按积压量平滑提速。
 * 模型事件仍然是真实来源；该队列不会补字、改字或预测内容。
 */
export class SmoothTextRevealQueue {
  private readonly options: SmoothTextRevealOptions;
  private pending: string[] = [];
  private started = false;
  private currentRate: number;
  private credit = 0;

  constructor(options: Partial<SmoothTextRevealOptions> = {}) {
    this.options = { ...DEFAULT_SMOOTH_REVEAL_OPTIONS, ...options };
    this.currentRate = this.options.baseRate;
  }

  get hasPending(): boolean {
    return this.pending.length > 0;
  }

  get pendingCount(): number {
    return this.pending.length;
  }

  push(text: string): string {
    const incoming = splitGraphemes(text);
    if (incoming.length === 0) return "";
    this.pending.push(...incoming);
    if (this.started) return "";
    this.started = true;
    return this.takeExact(Math.min(this.options.initialGroupSize, this.pending.length));
  }

  takeNext(elapsedMs = SMOOTH_REVEAL_TICK_MS): string {
    if (!this.pending.length) return "";
    const duration = Math.max(0, elapsedMs);
    const targetRate = Math.min(
      this.options.maxRate,
      this.options.baseRate + this.pending.length * 0.9,
    );
    const transitionMs = targetRate > this.currentRate
      ? this.options.accelerationMs
      : this.options.decelerationMs;
    const blend = 1 - Math.exp(-duration / Math.max(1, transitionMs));
    this.currentRate += (targetRate - this.currentRate) * blend;
    this.credit += this.currentRate * duration / 1000;

    let count = Math.min(this.options.maxGroupSize, this.pending.length, Math.floor(this.credit));
    if (count === 0) return "";
    // 避免常规节奏在末尾孤零零只剩一个字；极短尾段仍会完整显示。
    if (this.pending.length - count === 1 && count < this.options.maxGroupSize) count += 1;
    this.credit = Math.max(0, this.credit - count);
    return this.takeExact(count);
  }

  drain(): string {
    return this.takeExact(this.pending.length);
  }

  clear(): void {
    this.pending = [];
    this.started = false;
    this.currentRate = this.options.baseRate;
    this.credit = 0;
  }

  private takeExact(count: number): string {
    return this.pending.splice(0, count).join("");
  }
}
