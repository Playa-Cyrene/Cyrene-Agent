import { afterEach, describe, it, expect, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "path";
import { installSkillsSnapshot, SNAPSHOT_SENTINEL, snapshotSentinelPath } from "./snapshot-install";

/** 用内存目录模拟 fs，方便断言哨兵/解压行为。 */
function makeFs(initial: Record<string, string> = {}) {
  const files = new Map<string, string>(Object.entries(initial));
  return {
    files,
    existsSync: (p: string) => files.has(path.normalize(p)),
    mkdirSync: vi.fn((_p: string) => undefined),
    mkdtempSync: (prefix: string) => `${prefix}fixture`,
    rmdirSync: vi.fn((_p: string) => undefined),
    renameSync: (from: string, to: string) => {
      for (const [name, value] of [...files]) {
        if (name.startsWith(`${from}${path.sep}`)) {
          files.set(to + name.slice(from.length), value);
          files.delete(name);
        }
      }
    },
    rmSync: (dir: string) => {
      for (const name of files.keys()) if (name.startsWith(`${dir}${path.sep}`)) files.delete(name);
    },
    writeFileSync: vi.fn((p: string, c: string) => {
      files.set(path.normalize(p), c);
    }),
    readdirSync: (p: string) => {
      const prefix = path.normalize(p) + path.sep;
      const names = new Set<string>();
      for (const key of files.keys()) {
        if (key.startsWith(prefix)) {
          const rel = key.slice(prefix.length);
          const first = rel.split(path.sep)[0];
          if (first) names.add(first);
        }
      }
      return [...names];
    },
  };
}

describe("installSkillsSnapshot", () => {
  const archive = "C:\\vendor\\cyrene-skills\\skills-snapshot.zip";
  const userDir = "C:\\userData\\skills";

  it("归档不存在 → no_archive，不碰目标目录", async () => {
    const fsMock = makeFs();
    const status = await installSkillsSnapshot({
      archivePath: null,
      userSkillsDir: userDir,
      existsSync: fsMock.existsSync,
      mkdirSync: fsMock.mkdirSync,
      writeFileSync: fsMock.writeFileSync,
      readdirSync: fsMock.readdirSync,
      mkdtempSync: fsMock.mkdtempSync,
      rmdirSync: fsMock.rmdirSync,
      renameSync: fsMock.renameSync,
      rmSync: fsMock.rmSync,
    });
    expect(status).toBe("no_archive");
    expect(fsMock.mkdirSync).not.toHaveBeenCalled();
  });

  it("归档缺失文件时按不存在处理（existsSync 返回 false）", async () => {
    const fsMock = makeFs();
    const status = await installSkillsSnapshot({
      archivePath: archive,
      userSkillsDir: userDir,
      existsSync: () => false,
      mkdirSync: fsMock.mkdirSync,
      writeFileSync: fsMock.writeFileSync,
      readdirSync: fsMock.readdirSync,
      mkdtempSync: fsMock.mkdtempSync,
      rmdirSync: fsMock.rmdirSync,
      renameSync: fsMock.renameSync,
      rmSync: fsMock.rmSync,
    });
    expect(status).toBe("no_archive");
  });

  it("哨兵已存在 → skipped_sentinel，不重复解压", async () => {
    const fsMock = makeFs({ [archive]: "zip", [snapshotSentinelPath(userDir)]: "2026-01-01" });
    const extract = vi.fn(async () => undefined);
    const status = await installSkillsSnapshot({
      archivePath: archive,
      userSkillsDir: userDir,
      existsSync: fsMock.existsSync,
      mkdirSync: fsMock.mkdirSync,
      writeFileSync: fsMock.writeFileSync,
      readdirSync: fsMock.readdirSync,
      mkdtempSync: fsMock.mkdtempSync,
      rmdirSync: fsMock.rmdirSync,
      renameSync: fsMock.renameSync,
      rmSync: fsMock.rmSync,
      extract,
    });
    expect(status).toBe("skipped_sentinel");
    expect(extract).not.toHaveBeenCalled();
  });

  it("目标目录已有用户内容 → skipped_existing，写哨兵但不覆盖", async () => {
    const fsMock = makeFs({ [archive]: "zip", [path.join(userDir, "my-skill", "SKILL.md")]: "# mine" });
    const extract = vi.fn(async () => undefined);
    const status = await installSkillsSnapshot({
      archivePath: archive,
      userSkillsDir: userDir,
      existsSync: fsMock.existsSync,
      mkdirSync: fsMock.mkdirSync,
      writeFileSync: fsMock.writeFileSync,
      readdirSync: fsMock.readdirSync,
      mkdtempSync: fsMock.mkdtempSync,
      rmdirSync: fsMock.rmdirSync,
      renameSync: fsMock.renameSync,
      rmSync: fsMock.rmSync,
      extract,
    });
    expect(status).toBe("skipped_existing");
    expect(extract).not.toHaveBeenCalled();
    expect(fsMock.files.has(snapshotSentinelPath(userDir))).toBe(true);
  });

  it("首装成功 → installed，解压并写哨兵", async () => {
    const fsMock = makeFs({ [archive]: "zip" });
    const extract = vi.fn(async () => undefined);
    const status = await installSkillsSnapshot({
      archivePath: archive,
      userSkillsDir: userDir,
      existsSync: fsMock.existsSync,
      mkdirSync: fsMock.mkdirSync,
      writeFileSync: fsMock.writeFileSync,
      readdirSync: fsMock.readdirSync,
      mkdtempSync: fsMock.mkdtempSync,
      rmdirSync: fsMock.rmdirSync,
      renameSync: fsMock.renameSync,
      rmSync: fsMock.rmSync,
      extract,
    });
    expect(status).toBe("installed");
    expect(extract).toHaveBeenCalledWith(archive, { dir: expect.any(String) });
    expect(extract).not.toHaveBeenCalledWith(archive, { dir: userDir });
    expect(fsMock.files.has(snapshotSentinelPath(userDir))).toBe(true);
  });

  it("解压异常 → failed，不写哨兵（下次启动重试）", async () => {
    const fsMock = makeFs({ [archive]: "zip" });
    const extract = vi.fn(async () => {
      throw new Error("corrupt zip");
    });
    const status = await installSkillsSnapshot({
      archivePath: archive,
      userSkillsDir: userDir,
      existsSync: fsMock.existsSync,
      mkdirSync: fsMock.mkdirSync,
      writeFileSync: fsMock.writeFileSync,
      readdirSync: fsMock.readdirSync,
      mkdtempSync: fsMock.mkdtempSync,
      rmdirSync: fsMock.rmdirSync,
      renameSync: fsMock.renameSync,
      rmSync: fsMock.rmSync,
      extract,
    });
    expect(status).toBe("failed");
    expect(fsMock.files.has(snapshotSentinelPath(userDir))).toBe(false);
  });

  it("哨兵文件名常量暴露给调用方", () => {
    expect(SNAPSHOT_SENTINEL).toBe(".snapshot-installed");
  });
});

describe("快照安装失败后的真实文件系统恢复", () => {
  const roots: string[] = [];
  afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
  function fixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "snapshot-recovery-"));
    roots.push(root);
    const archivePath = path.join(root, "snapshot.zip");
    const userSkillsDir = path.join(root, "skills");
    fs.writeFileSync(archivePath, "fixture");
    return { root, archivePath, userSkillsDir };
  }
  const writeSkill = (dir: string, name: string, value = name) => {
    fs.mkdirSync(path.join(dir, name), { recursive: true });
    fs.writeFileSync(path.join(dir, name, "SKILL.md"), value);
  };

  it("部分解压失败不会污染目标目录，下次启动可以完整安装", async () => {
    const input = fixture();
    expect(await installSkillsSnapshot({ ...input, extract: async (_, { dir }) => {
      writeSkill(dir, "partial");
      throw new Error("I/O after first entry");
    } })).toBe("failed");
    const retry = vi.fn(async (_: string, { dir }: { dir: string }) => writeSkill(dir, "complete"));
    expect(await installSkillsSnapshot({ ...input, extract: retry })).toBe("installed");
    expect(retry).toHaveBeenCalledOnce();
    expect(fs.existsSync(path.join(input.userSkillsDir, "partial"))).toBe(false);
    expect(fs.readFileSync(path.join(input.userSkillsDir, "complete", "SKILL.md"), "utf8")).toBe("complete");
    expect(await installSkillsSnapshot({ ...input, extract: retry })).toBe("skipped_sentinel");
  });

  it("完成哨兵写入失败后仍可重试，不发布未完成的目标目录", async () => {
    const input = fixture();
    const extract = vi.fn(async (_: string, { dir }: { dir: string }) => writeSkill(dir, "complete"));
    expect(await installSkillsSnapshot({ ...input, extract, writeFileSync: () => { throw new Error("disk full"); } })).toBe("failed");
    expect(await installSkillsSnapshot({ ...input, extract })).toBe("installed");
    expect(extract).toHaveBeenCalledTimes(2);
  });

  it("解压期间新出现的用户内容不可被覆盖", async () => {
    const input = fixture();
    await installSkillsSnapshot({ ...input, extract: async (_, { dir }) => {
      writeSkill(input.userSkillsDir, "custom", "USER CONTENT");
      writeSkill(dir, "custom", "ARCHIVE CONTENT");
    } });
    expect(fs.readFileSync(path.join(input.userSkillsDir, "custom", "SKILL.md"), "utf8")).toBe("USER CONTENT");
  });

  it("未完成暂存残留不阻止下次安装，也不被当作用户技能", async () => {
    const input = fixture();
    let abandoned = "";
    expect(await installSkillsSnapshot({ ...input, extract: async (_, { dir }) => {
      abandoned = dir;
      writeSkill(dir, "partial");
      throw new Error("interrupted extraction");
    }, rmSync: () => { throw new Error("cleanup unavailable"); } })).toBe("failed");
    expect(fs.existsSync(path.join(abandoned, "partial", "SKILL.md"))).toBe(true);
    expect(await installSkillsSnapshot({ ...input, extract: async (_, { dir }) => writeSkill(dir, "complete") })).toBe("installed");
    expect(fs.readdirSync(input.userSkillsDir).sort()).toEqual([SNAPSHOT_SENTINEL, "complete"]);
  });

  it("启动阶段已创建的空用户目录可以原子替换为完整快照", async () => {
    const input = fixture();
    fs.mkdirSync(input.userSkillsDir);
    expect(await installSkillsSnapshot({ ...input, extract: async (_, { dir }) => writeSkill(dir, "complete") })).toBe("installed");
    expect(fs.readFileSync(path.join(input.userSkillsDir, "complete", "SKILL.md"), "utf8")).toBe("complete");
    expect(fs.existsSync(snapshotSentinelPath(input.userSkillsDir))).toBe(true);
  });
});
