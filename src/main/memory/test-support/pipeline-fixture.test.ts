import { expect, it, vi } from "vitest"
import { PipelineCleanupGuard, PipelineFixture } from "../../../../tests/helpers/memory-pipeline-fixture"

it("releases a held judge and drains the failed test before cleanup", async () => {
  const fixture = new PipelineFixture()
  const gate = fixture.gate("empty")
  const laterWrite = vi.fn()
  const run = fixture.run(async () => {
    await fixture.step("judge", gate.wait)
    laterWrite()
  })
  const rejected = expect(run).rejects.toThrow("PIPELINE_FIXTURE_STOPPING:judge")
  await gate.entered
  expect(fixture.diagnostic()).toContain("judge:")
  await fixture.stop()
  await rejected
  expect(laterWrite).not.toHaveBeenCalled()
})

it("unblocks entry wait when failure happens before a judge starts", async () => {
  const fixture = new PipelineFixture()
  const gate = fixture.gate("empty")
  const run = fixture.run(async () => { await fixture.step("judge entry", () => gate.entered) })
  const rejected = expect(run).rejects.toThrow("PIPELINE_FIXTURE_STOPPING:judge entry")
  await Promise.resolve()
  await fixture.stop()
  await rejected
})

it("preserves an explicit judge result and reports completed stage durations", async () => {
  const fixture = new PipelineFixture()
  const gate = fixture.gate("empty")
  await fixture.run(async () => {
    const pending = fixture.step("judge", gate.wait)
    await gate.entered
    gate.release("current")
    expect(await pending).toBe("current")
  })
  expect(fixture.diagnostic()).toMatch(/judge: \d+ms/)
  await fixture.stop()
})

it("does not swallow the original test error or execute work after stop", async () => {
  const fixture = new PipelineFixture()
  await expect(fixture.run(async () => { throw new Error("assertion failure") })).rejects.toThrow("assertion failure")
  await fixture.stop()
  const work = vi.fn()
  await expect(fixture.step("late write", work)).rejects.toThrow("PIPELINE_FIXTURE_STOPPING")
  expect(work).not.toHaveBeenCalled()
})

it("blocks next-case setup while an old teardown is delayed, then permits it after success", async () => {
  const guard = new PipelineCleanupGuard()
  let release!: () => void
  const pending = guard.finish(() => new Promise<void>(resolve => { release = resolve }))
  expect(() => guard.assertReady()).toThrow("PREVIOUS_PIPELINE_CLEANUP_INCOMPLETE")
  release()
  await pending
  expect(() => guard.assertReady()).not.toThrow()
})

it("does not reset shared mocks after a failed teardown", async () => {
  const guard = new PipelineCleanupGuard()
  await expect(guard.finish(async () => { throw new Error("worker close failed") })).rejects.toThrow("worker close failed")
  expect(() => guard.assertReady()).toThrow("PREVIOUS_PIPELINE_CLEANUP_INCOMPLETE")
})
