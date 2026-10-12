import * as fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { StartupAnimationSettings } from "../../shared/startup-animation";

export const MAX_STARTUP_VIDEO_BYTES = 500 * 1024 * 1024;
const managedName = /^[a-f0-9-]{36}\.mp4$/i;

/** Local copied media and settings shared with the animation launcher. */
export class StartupAnimationStore {
  readonly settingsPath: string;
  constructor(readonly directory: string) {
    this.settingsPath = path.join(directory, "settings.json");
  }

  read(): StartupAnimationSettings {
    try {
      const input = JSON.parse(fs.readFileSync(this.settingsPath, "utf8"));
      const videoFile = typeof input.videoFile === "string" && managedName.test(input.videoFile)
        && fs.existsSync(path.join(this.directory, input.videoFile)) ? input.videoFile : null;
      const mode = input.enabled === false || input.mode === "off" ? "off"
        : input.mode === "always" || input.mode === "except-tray" ? input.mode : "startup";
      return { enabled: mode !== "off", mode, videoFile,
        videoName: videoFile && typeof input.videoName === "string" ? input.videoName.slice(0, 255) : null };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return { enabled: true, mode: "startup", videoFile: null, videoName: null };
    }
  }

  private write(settings: StartupAnimationSettings): StartupAnimationSettings {
    fs.mkdirSync(this.directory, { recursive: true });
    const temporary = `${this.settingsPath}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify(settings, null, 2), "utf8");
      fs.renameSync(temporary, this.settingsPath);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
    return settings;
  }

  setEnabled(enabled: unknown): StartupAnimationSettings {
    if (typeof enabled !== "boolean") throw new Error("动画开关必须为布尔值");
    const settings = this.read();
    return this.setMode(enabled ? (settings.mode === "off" ? "startup" : settings.mode) : "off");
  }

  setMode(mode: unknown): StartupAnimationSettings {
    if (mode !== "off" && mode !== "startup" && mode !== "except-tray" && mode !== "always") throw new Error("无效的动画播放模式");
    // Keep enabled for older standalone launchers sharing this settings file.
    return this.write({ ...this.read(), mode, enabled: mode !== "off" });
  }

  resetVideo(): StartupAnimationSettings {
    // Retain previous copies: a running launcher may still be reading one.
    return this.write({ ...this.read(), videoFile: null, videoName: null });
  }

  async importVideo(source: string): Promise<StartupAnimationSettings> {
    if (path.extname(source).toLowerCase() !== ".mp4") throw new Error("请选择 MP4 视频（H.264 编码）");
    const stat = await fs.promises.stat(source);
    if (!stat.isFile() || stat.size > MAX_STARTUP_VIDEO_BYTES || stat.size < 24) {
      throw new Error("视频文件无效或超过 500 MB");
    }
    await fs.promises.mkdir(this.directory, { recursive: true });
    const videoFile = `${randomUUID()}.mp4`;
    const destination = path.join(this.directory, videoFile);
    try {
      await fs.promises.copyFile(source, destination, fs.constants.COPYFILE_EXCL);
      await validateMp4(destination);
      // Read after the asynchronous copy so concurrent toggle changes are preserved.
      return this.write({ ...this.read(), videoFile, videoName: path.basename(source) });
    } catch (error) {
      await fs.promises.rm(destination, { force: true });
      throw error;
    }
  }
}

/** Reject renamed files and truncated MP4 containers without reading video payload into memory. */
export async function validateMp4(file: string): Promise<void> {
  const handle = await fs.promises.open(file, "r");
  try {
    const { size } = await handle.stat();
    if (size > MAX_STARTUP_VIDEO_BYTES) throw new Error("视频超过 500 MB");
    let offset = 0;
    const boxes = new Set<string>();
    const header = Buffer.alloc(16);
    let count = 0;
    while (offset < size) {
      if (++count > 100000 || size - offset < 8) throw new Error("MP4 文件结构无效");
      const { bytesRead } = await handle.read(header, 0, Math.min(16, size - offset), offset);
      let length = header.readUInt32BE(0);
      const type = header.toString("ascii", 4, 8);
      let headerLength = 8;
      if (length === 1) {
        if (bytesRead < 16) throw new Error("MP4 文件不完整");
        length = Number(header.readBigUInt64BE(8));
        headerLength = 16;
      } else if (length === 0) length = size - offset;
      if (!Number.isSafeInteger(length) || length < headerLength || offset + length > size) throw new Error("MP4 文件不完整");
      if (length > headerLength) boxes.add(type);
      offset += length;
    }
    if (!["ftyp", "moov", "mdat"].every((type) => boxes.has(type))) throw new Error("请选择有效的 MP4 视频");
  } finally {
    await handle.close();
  }
}
