/**
 * ObsidianWorkspaceService 写契约测试 —— 直接测试 edit() 的不变量：
 * - create 永不覆盖：目标已存在一律拒绝（PATH_ALREADY_EXISTS）
 * - 修改已有文件必须携带 expectedContentHash（CONTENT_HASH_REQUIRED / CONTENT_CONFLICT）
 * - resolveSafe 保护 .obsidian/ 与 .cyrene/ 内部目录
 * - isEmptyDirectory 忽略 .cyrene/（Learn bootstrap 兼容 Cyrene Notes）
 */

import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  ObsidianWorkspaceService,
  ObsidianError,
} from "./obsidian-workspace-service"
import { contentHash, extractHeadings } from "./obsidian-markdown"
import { isEmptyDirectory } from "./vault-init"

describe("ObsidianWorkspaceService 写契约不变量", () => {
  let vaultRoot: string
  let service: ObsidianWorkspaceService

  beforeEach(() => {
    vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-vault-test-"))
    service = new ObsidianWorkspaceService()
    service.configure({ enabled: true, vaultPath: vaultRoot })
  })

  afterEach(() => {
    fs.rmSync(vaultRoot, { recursive: true, force: true })
  })

  const writeFile = (rel: string, content: string) => {
    const full = path.join(vaultRoot, rel)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, content, "utf-8")
  }

  const expectError = async (promise: Promise<unknown>, code: string) => {
    try {
      await promise
      expect.unreachable(`预期抛出 ${code}`)
    } catch (err) {
      expect(err).toBeInstanceOf(ObsidianError)
      expect((err as ObsidianError).code).toBe(code)
    }
  }

  describe("create 永不覆盖", () => {
    it("目标不存在时创建成功", async () => {
      const result = await service.edit({
        operation: "create",
        path: "notes/new.md",
        content: "# 新笔记\n",
      })
      expect(result.operation).toBe("create")
      expect(result.newContentHash).toBe(contentHash("# 新笔记\n"))
      expect(fs.existsSync(path.join(vaultRoot, "notes/new.md"))).toBe(true)
    })

    it("目标已存在时拒绝（PATH_ALREADY_EXISTS），且原内容不被破坏", async () => {
      writeFile("notes/exist.md", "# 原内容\n")
      await expectError(
        service.edit({
          operation: "create",
          path: "notes/exist.md",
          content: "# 会被拒绝的内容\n",
        }),
        "PATH_ALREADY_EXISTS",
      )
      expect(fs.readFileSync(path.join(vaultRoot, "notes/exist.md"), "utf-8")).toBe("# 原内容\n")
    })

    it("嵌套路径不存在时报 PATH_NOT_FOUND（不静默建目录）", async () => {
      await expectError(
        service.edit({
          operation: "replace_file",
          path: "notes/never-created.md",
          content: "x",
          expectedContentHash: "whatever",
        }),
        "PATH_NOT_FOUND",
      )
    })
  })

  describe("修改已有文件必须携带 expectedContentHash", () => {
    it("缺失 expectedContentHash 时拒绝（CONTENT_HASH_REQUIRED）", async () => {
      writeFile("notes/a.md", "# A\n")
      // 绕过 TS 类型模拟工具层 JSON 入参（obsidian-tools.ts 以 as any 调用）
      await expectError(
        service.edit({
          operation: "replace_file",
          path: "notes/a.md",
          content: "# 改\n",
        } as any),
        "CONTENT_HASH_REQUIRED",
      )
      expect(fs.readFileSync(path.join(vaultRoot, "notes/a.md"), "utf-8")).toBe("# A\n")
    })

    it("四种修改操作缺失 hash 时全部拒绝", async () => {
      writeFile("notes/a.md", "# A\n\n## S1\n\n内容\n")
      const cases = [
        { operation: "replace_file", content: "x" },
        { operation: "append", content: "x" },
        { operation: "replace_section", content: "x", headingPath: ["A", "S1"] },
        { operation: "append_to_section", content: "x", headingPath: ["A", "S1"] },
      ]
      for (const c of cases) {
        await expectError(
          service.edit({ path: "notes/a.md", ...c } as any),
          "CONTENT_HASH_REQUIRED",
        )
      }
      // 四次尝试后文件内容不变
      expect(fs.readFileSync(path.join(vaultRoot, "notes/a.md"), "utf-8")).toBe(
        "# A\n\n## S1\n\n内容\n",
      )
    })

    it("hash 匹配时 replace_file 成功，返回新 hash", async () => {
      writeFile("notes/a.md", "# A\n")
      const read = await service.readFile({ path: "notes/a.md" })
      const result = await service.edit({
        operation: "replace_file",
        path: "notes/a.md",
        content: "# A 改\n",
        expectedContentHash: read.contentHash,
      })
      expect(result.newContentHash).toBe(contentHash("# A 改\n"))
    })

    it("hash 不匹配（外部修改）时拒绝（CONTENT_CONFLICT）", async () => {
      writeFile("notes/a.md", "# A\n")
      const staleHash = contentHash("# 旧版本\n")
      await expectError(
        service.edit({
          operation: "replace_file",
          path: "notes/a.md",
          content: "# A 改\n",
          expectedContentHash: staleHash,
        }),
        "CONTENT_CONFLICT",
      )
      expect(fs.readFileSync(path.join(vaultRoot, "notes/a.md"), "utf-8")).toBe("# A\n")
    })

    it("append 携带正确 hash 成功且保留原内容", async () => {
      writeFile("notes/a.md", "# A\n")
      const read = await service.readFile({ path: "notes/a.md" })
      await service.edit({
        operation: "append",
        path: "notes/a.md",
        content: "追加内容",
        expectedContentHash: read.contentHash,
      })
      expect(fs.readFileSync(path.join(vaultRoot, "notes/a.md"), "utf-8")).toBe(
        "# A\n追加内容\n",
      )
    })
  })

  describe("内部目录保护（resolveSafe）", () => {
    it("拒绝读写 .cyrene/ 下的文件", async () => {
      await expectError(
        service.readFile({ path: ".cyrene/workspace.json" }),
        "PATH_OUTSIDE_VAULT",
      )
      await expectError(
        service.edit({
          operation: "create",
          path: ".cyrene/evil.md",
          content: "x",
        }),
        "PATH_OUTSIDE_VAULT",
      )
    })

    it("拒绝读写 .obsidian/ 下的文件", async () => {
      await expectError(
        service.readFile({ path: ".obsidian/app.json" }),
        "PATH_OUTSIDE_VAULT",
      )
      await expectError(
        service.edit({
          operation: "create",
          path: ".obsidian/x.md",
          content: "x",
        }),
        "PATH_OUTSIDE_VAULT",
      )
    })

    it("listFiles 不列出 .cyrene/ 内的文件（扩展名白名单兜底 + 跳过逻辑）", async () => {
      writeFile("notes/visible.md", "# V\n")
      writeFile(".cyrene/index.db", "fake-db")
      writeFile(".cyrene/leak.md", "# 不该被列出\n")
      const files = await service.listFiles({ recursive: true })
      const paths = files.map((f) => f.path)
      expect(paths).toContain("notes/visible.md")
      expect(paths.some((p) => p.startsWith(".cyrene/"))).toBe(false)
    })
  })

  describe("isEmptyDirectory 兼容 .cyrene/（Learn bootstrap）", () => {
    it("只含 .cyrene/ 时仍判定为空", async () => {
      fs.mkdirSync(path.join(vaultRoot, ".cyrene/history"), { recursive: true })
      fs.writeFileSync(path.join(vaultRoot, ".cyrene/index.db"), "x")
      expect(await isEmptyDirectory(vaultRoot)).toBe(true)
    })

    it("只含 .obsidian/ 时仍判定为空（既有行为不回归）", async () => {
      fs.mkdirSync(path.join(vaultRoot, ".obsidian"), { recursive: true })
      expect(await isEmptyDirectory(vaultRoot)).toBe(true)
    })

    it("存在用户笔记时判定为非空", async () => {
      writeFile("notes/user.md", "# 用户笔记\n")
      expect(await isEmptyDirectory(vaultRoot)).toBe(false)
    })

    it("不存在时判定为空（不抛错）", async () => {
      expect(await isEmptyDirectory(path.join(vaultRoot, "never"))).toBe(true)
    })
  })
})

describe("obsidian-markdown 语义回归（C2 依赖的既有语义不变）", () => {
  it("contentHash 对原始字节稳定（CRLF 与 LF 必须给出不同 hash）", () => {
    expect(contentHash("# A\n")).toBe(contentHash("# A\n"))
    expect(contentHash("# A\n")).not.toBe(contentHash("# A\r\n"))
  })

  it("extractHeadings 对 LF 文件的标题路径栈", () => {
    const headings = extractHeadings("# 一\n\n## 二\n\n内容\n\n# 三\n")
    expect(headings.map((h) => h.path)).toEqual([
      ["一"],
      ["一", "二"],
      ["三"],
    ])
  })
})
