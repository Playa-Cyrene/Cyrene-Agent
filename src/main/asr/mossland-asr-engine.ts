import { resolveTimeoutPolicy } from "../runtime-policy";
import {
  buildMosslandError,
  MOSSLAND_BASE_URL,
  mosslandFetch,
} from "../mossland/api-client";

const SAMPLE_RATE = 16_000;
const CHANNELS = 1;
const BITS_PER_SAMPLE = 16;

/** 将通话采集的 PCM 16kHz/16bit/mono 数据封装成标准 WAV 文件。 */
export function encodePcm16MonoWav(pcm: Buffer): Buffer {
  const header = Buffer.alloc(44);
  const byteRate = SAMPLE_RATE * CHANNELS * (BITS_PER_SAMPLE / 8);
  const blockAlign = CHANNELS * (BITS_PER_SAMPLE / 8);

  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(CHANNELS, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(BITS_PER_SAMPLE, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);

  return Buffer.concat([header, pcm]);
}

async function transcribeWav(apiKey: string, wav: Buffer): Promise<string> {
  const form = new FormData();
  form.append("model", "moss-transcribe");
  form.append("response_format", "json");
  // Buffer 底层可能是 SharedArrayBuffer，不满足新版类型的 BlobPart 约束；拷贝成独立 ArrayBuffer 背书的 Uint8Array
  form.append("file", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "speech.wav");

  const response = await mosslandFetch(`${MOSSLAND_BASE_URL}/v1/audio/transcriptions`, {
    method: "POST",
    apiKey,
    timeoutMs: resolveTimeoutPolicy({ stage: "asr-mossland" }).totalMs,
    body: form,
  });
  if (!response.ok) {
    throw buildMosslandError("Mossland 转写失败", response.status, await response.text());
  }

  const data = await response.json() as { text?: unknown };
  if (typeof data.text !== "string") {
    throw new Error("Mossland 转写失败：服务端未返回 text");
  }
  return data.text.trim();
}

/** Mossland 批量转写会话：缓存一轮 PCM，stop 时上传 WAV 并返回完整文本。 */
export class MosslandAsrStream {
  private readonly frames: Buffer[] = [];
  private stopPromise: Promise<string> | null = null;

  constructor(
    private readonly apiKey: string,
    private readonly onFinal: (text: string) => void,
  ) {}

  async start(): Promise<void> {
    if (!this.apiKey.trim()) {
      throw new Error("Mossland 转写失败：缺少 API Key");
    }
  }

  sendAudio(pcmFrame: Buffer): void {
    if (this.stopPromise || pcmFrame.length === 0) return;
    this.frames.push(Buffer.from(pcmFrame));
  }

  stop(): Promise<string> {
    if (!this.stopPromise) {
      this.stopPromise = this.finish();
    }
    return this.stopPromise;
  }

  private async finish(): Promise<string> {
    if (this.frames.length === 0) return "";
    const text = await transcribeWav(this.apiKey, encodePcm16MonoWav(Buffer.concat(this.frames)));
    if (text) this.onFinal(text);
    return text;
  }
}
