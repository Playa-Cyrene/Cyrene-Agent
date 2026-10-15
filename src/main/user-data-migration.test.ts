import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { migrateLegacyUserData } from "./user-data-migration";

// 用临时目录模拟 appData，构造旧目录 live2d-cyrene 与新目录 Cyrene 的各种组合
let root: string;

function legacyDir(): string {
  return path.join(root, "live2d-cyrene");
}

function targetDir(): string {
  return path.join(root, "Cyrene");
}

function writeFixture(dir: string, name: string, content: string): void {
  fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
  fs.writeFileSync(path.join(dir, name), content);
}

function readTarget(name: string): string {
  return fs.readFileSync(path.join(targetDir(), name), "utf8");
}

/** 备份目录里某个条目的所有被覆盖版本（备份按时间戳分子目录） */
function backedUp(name: string): string[] {
  const root = path.join(targetDir(), ".legacy-migration-overwritten");
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root)
    .map((stamp) => path.join(root, stamp, name))
    .filter((file) => fs.existsSync(file))
    .map((file) => fs.readFileSync(file, "utf8"));
}

function migrate() {
  return migrateLegacyUserData({ appDataPath: root, targetUserDataPath: targetDir() });
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-migration-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("migrateLegacyUserData", () => {
  it("旧目录不存在时什么都不做", () => {
    const result = migrateLegacyUserData({ appDataPath: root, targetUserDataPath: targetDir() });
    expect(result.status).toBe("none");
    expect(fs.existsSync(legacyDir())).toBe(false);
    expect(fs.existsSync(targetDir())).toBe(false);
  });

  it("新旧目录路径一致时跳过", () => {
    fs.mkdirSync(legacyDir(), { recursive: true });
    const result = migrateLegacyUserData({ appDataPath: root, targetUserDataPath: legacyDir() });
    expect(result.status).toBe("skipped");
    expect(fs.existsSync(legacyDir())).toBe(true);
  });

  it("目标不存在时整体重命名", () => {
    writeFixture(legacyDir(), "app-settings.json", "{}");
    writeFixture(legacyDir(), "cyrene-chats/conv-1.json", "{}");

    const result = migrateLegacyUserData({ appDataPath: root, targetUserDataPath: targetDir() });

    expect(result.status).toBe("renamed");
    expect(fs.existsSync(legacyDir())).toBe(false);
    expect(fs.existsSync(path.join(targetDir(), "app-settings.json"))).toBe(true);
    expect(fs.existsSync(path.join(targetDir(), "cyrene-chats/conv-1.json"))).toBe(true);
  });

  it("两者并存时逐项并入且旧数据优先", () => {
    // 旧目录：真实用户数据
    writeFixture(legacyDir(), "app-settings.json", '{"language":"zh-CN"}');
    writeFixture(legacyDir(), "memory.json", "{}");
    // 新目录：安装器写入的文件 + 一个会被旧数据覆盖的残留
    writeFixture(targetDir(), "installer-options.json", '{"launchAtLogin":true}');
    writeFixture(targetDir(), "app-settings.json", '{"petVisible":false}');

    const result = migrateLegacyUserData({ appDataPath: root, targetUserDataPath: targetDir() });

    expect(result.status).toBe("merged");
    // 旧数据覆盖新目录同名文件
    expect(fs.readFileSync(path.join(targetDir(), "app-settings.json"), "utf8")).toBe('{"language":"zh-CN"}');
    // 新目录独有文件保留（开机自启勾选不能丢）
    expect(fs.readFileSync(path.join(targetDir(), "installer-options.json"), "utf8")).toBe('{"launchAtLogin":true}');
    expect(fs.existsSync(path.join(targetDir(), "memory.json"))).toBe(true);
    // 被覆盖的目标版本移进备份目录，而不是直接删除
    expect(backedUp("app-settings.json")).toEqual(['{"petVisible":false}']);
    // 全部搬空后旧目录移除
    expect(fs.existsSync(legacyDir())).toBe(false);
  });

  it("运行时锁文件不迁移：保留新目录版本，丢弃旧目录陈旧副本", () => {
    writeFixture(legacyDir(), "lockfile", "stale-pid");
    writeFixture(legacyDir(), "memory.json", "{}");
    writeFixture(targetDir(), "lockfile", "fresh-pid");

    const result = migrateLegacyUserData({ appDataPath: root, targetUserDataPath: targetDir() });

    expect(result.status).toBe("merged");
    expect(fs.readFileSync(path.join(targetDir(), "lockfile"), "utf8")).toBe("fresh-pid");
    expect(fs.existsSync(path.join(targetDir(), "memory.json"))).toBe(true);
    expect(fs.existsSync(legacyDir())).toBe(false);
  });
});

describe("migrateLegacyUserData — 迁移只发生一次", () => {
  // 复现场景：升级后又运行了一次 1.2.x 旧版，旧版按旧名字重新建出 live2d-cyrene，
  // 里面是旧版的默认/陈旧文件。修复前，下次启动会再次「旧数据优先」并入，覆盖当前数据。
  it("重命名迁移后旧目录被旧版重新创建：不再并入，当前数据不被覆盖", () => {
    writeFixture(legacyDir(), "model-settings.json", '{"model":"deepseek"}');
    expect(migrate().status).toBe("renamed");

    // 用户在新版里继续使用，数据更新
    writeFixture(targetDir(), "model-settings.json", '{"model":"deepseek","profiles":2}');
    // 旧版重新建出旧目录，写入陈旧的默认配置
    writeFixture(legacyDir(), "model-settings.json", '{"model":"stale-default"}');

    expect(migrate().status).toBe("already_migrated");
    expect(readTarget("model-settings.json")).toBe('{"model":"deepseek","profiles":2}');
    // 重新出现的旧目录原样保留，不删除任何东西
    expect(fs.readFileSync(path.join(legacyDir(), "model-settings.json"), "utf8")).toBe('{"model":"stale-default"}');
  });

  it("合并迁移成功后同样写入完成标记，重新出现的旧目录不再并入", () => {
    writeFixture(legacyDir(), "memory.json", '{"v":"real"}');
    writeFixture(targetDir(), "installer-options.json", "{}");
    expect(migrate().status).toBe("merged");

    writeFixture(legacyDir(), "memory.json", '{"v":"stale"}');
    expect(migrate().status).toBe("already_migrated");
    expect(readTarget("memory.json")).toBe('{"v":"real"}');
  });

  it("修复之前已完成迁移的安装：旧目录不在时补记标记，之后旧目录再出现也不并入", () => {
    // 已有安装：只有新目录，没有完成标记
    writeFixture(targetDir(), "app-settings.json", '{"current":true}');
    expect(migrate().status).toBe("none");
    expect(fs.existsSync(path.join(targetDir(), ".legacy-user-data-migrated"))).toBe(true);

    writeFixture(legacyDir(), "app-settings.json", '{"current":false}');
    expect(migrate().status).toBe("already_migrated");
    expect(readTarget("app-settings.json")).toBe('{"current":true}');
  });

  it("首次合并（安装器已建好新目录、尚无标记）仍按旧数据优先完成迁移", () => {
    writeFixture(targetDir(), "installer-options.json", '{"launchAtLogin":true}');
    writeFixture(legacyDir(), "app-settings.json", '{"language":"zh-CN"}');

    expect(migrate().status).toBe("merged");
    expect(readTarget("app-settings.json")).toBe('{"language":"zh-CN"}');
    expect(readTarget("installer-options.json")).toBe('{"launchAtLogin":true}');
  });
});
