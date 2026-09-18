import type { AsrConfig } from "./asr-config";
import { MosslandAsrStream } from "./mossland-asr-engine";
import { AliyunAsrStream } from "./aliyun-asr-engine";

export interface AsrStreamSession {
  start(): Promise<void>;
  sendAudio(frame: Buffer): void;
  stop(): void | Promise<string>;
}

export function createAsrStream(
  config: AsrConfig,
  onPartial: (text: string) => void,
  onFinal: (text: string) => void,
): AsrStreamSession {
  if (config.engine === "mossland") {
    return new MosslandAsrStream(config.apiKey, onFinal);
  }

  const stream = new AliyunAsrStream(onPartial, onFinal);
  return {
    start: () => stream.start(
      config.appKey,
      config.accessKeyId,
      config.accessKeySecret,
      config.language,
    ),
    sendAudio: (frame) => stream.sendAudio(frame),
    stop: () => stream.stop(),
  };
}
