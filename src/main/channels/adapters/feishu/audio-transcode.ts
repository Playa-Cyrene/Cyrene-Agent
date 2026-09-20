import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { detectMpvBinary } from "../../../music/mpv-controller";

export interface FeishuAudioTranscodeDeps {
  resolveMpvBinary?: () => string;
  runMpv?: (executable: string, args: string[]) => Promise<void>;
}

function runMpvProcess(executable: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 16_000) stderr += chunk.toString("utf8");
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`mpv Opus 转码失败（exit=${code}）${stderr.trim() ? `: ${stderr.trim()}` : ""}`));
    });
  });
}

export async function transcodeAudioFileToFeishuOpus(
  inputPath: string,
  deps: FeishuAudioTranscodeDeps = {},
): Promise<string> {
  const outputPath = path.join(
    path.dirname(inputPath),
    `${path.basename(inputPath, path.extname(inputPath))}-${randomUUID()}.opus`,
  );
  // 找不到 mpv 时提前报错，避免把 null 传给子进程
  const mpvBinary = (deps.resolveMpvBinary ?? detectMpvBinary)();
  if (!mpvBinary) {
    throw new Error("未找到可用的 mpv，无法将音频转码为飞书 Opus 格式");
  }
  const args = [
    "--no-config",
    "--no-video",
    "--really-quiet",
    `--o=${outputPath}`,
    "--of=opus",
    "--oac=libopus",
    "--audio-channels=mono",
    "--audio-samplerate=48000",
    inputPath,
  ];

  try {
    await (deps.runMpv ?? runMpvProcess)(mpvBinary, args);
    const header = await fs.promises.readFile(outputPath);
    if (header.length < 4 || header.subarray(0, 4).toString("ascii") !== "OggS") {
      throw new Error("mpv 返回的文件不是有效的 Ogg Opus 音频");
    }
    return outputPath;
  } catch (error) {
    await fs.promises.rm(outputPath, { force: true }).catch(() => {});
    throw error;
  }
}
