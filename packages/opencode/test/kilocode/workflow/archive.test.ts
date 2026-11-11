import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect } from "effect"
import { WorkflowArchive } from "../../../src/kilocode/workflow/archive"
import type { AgentInfo, RunDetail } from "../../../src/kilocode/workflow/types"
import { tmpdir } from "../../fixture/fixture"

/** A pid no process can have (above every pid_max), so the run's process is gone. */
const GONE = 2_147_483_000

const agent = (index: number, status: AgentInfo["status"], phase: string): AgentInfo => ({
  id: `a${index}`,
  index,
  label: `agent-${index}`,
  phase,
  status,
  agentType: "workflow-subagent",
  tokens: 10,
  tools: 1,
  started: 1_000,
  ...(status === "running" || status === "queued" ? {} : { ended: 2_000 }),
  prompt: `prompt ${index}`,
})

const detail = (id: string, status: RunDetail["status"], list: AgentInfo[] = []): RunDetail => ({
  id,
  sessionID: "ses_one",
  name: id,
  description: `Run ${id}`,
  status,
  phases: [
    {
      title: "Scan",
      total: list.length,
      running: list.filter((item) => item.status === "running").length,
      done: 0,
      error: 0,
      skipped: 0,
    },
  ],
  agents: list.length,
  running: list.filter((item) => item.status === "running").length,
  done: list.filter((item) => item.status === "completed").length,
  error: 0,
  skipped: 0,
  cached: 0,
  tokens: 10 * list.length,
  tools: list.length,
  size: "medium",
  started: 1_000,
  ...(status === "running" || status === "paused" ? {} : { ended: 3_000 }),
  dir: `/data/workflow/ses_one/${id}`,
  script: `/data/workflow/ses_one/${id}/script.js`,
  logs: ["started"],
  list,
  ...(status === "completed" ? { result: '"done"' } : {}),
})

async function persist(root: string, value: RunDetail, pid?: number) {
  const dir = path.join(root, value.sessionID, value.id)
  await fs.mkdir(dir, { recursive: true })
  const body = pid === undefined ? WorkflowArchive.record(value) : { ...value, pid }
  await Bun.write(path.join(dir, WorkflowArchive.FILE), JSON.stringify(body))
  return dir
}

describe("WorkflowArchive", () => {
  test("finds a persisted run by id under any session, or under the given one", async () => {
    await using tmp = await tmpdir()
    const done = detail("wf_done", "completed", [agent(0, "completed", "Scan")])
    await persist(tmp.path, done)
    await fs.mkdir(path.join(tmp.path, "ses_two", "wf_other"), { recursive: true })

    expect(await Effect.runPromise(WorkflowArchive.get(tmp.path, "wf_done"))).toEqual(done)
    expect(await Effect.runPromise(WorkflowArchive.get(tmp.path, "wf_done", "ses_one"))).toEqual(done)
    expect(await Effect.runPromise(WorkflowArchive.get(tmp.path, "wf_done", "ses_two"))).toBeUndefined()
    expect(await Effect.runPromise(WorkflowArchive.get(tmp.path, "wf_other"))).toBeUndefined()
    expect(await Effect.runPromise(WorkflowArchive.get(tmp.path, "wf_missing"))).toBeUndefined()
    expect(await Effect.runPromise(WorkflowArchive.get(path.join(tmp.path, "absent"), "wf_done"))).toBeUndefined()
  })

  test("never resolves ids outside the root", async () => {
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, "workflow")
    await persist(tmp.path, { ...detail("wf_escape", "completed"), sessionID: "outside" })
    await fs.mkdir(root, { recursive: true })
    expect(await Effect.runPromise(WorkflowArchive.get(root, "../outside/wf_escape"))).toBeUndefined()
    expect(await Effect.runPromise(WorkflowArchive.get(root, "wf_escape", "../outside"))).toBeUndefined()
    expect(await Effect.runPromise(WorkflowArchive.list(root, ".."))).toEqual([])
  })

  test("lists a session's persisted runs, skipping known ids and unreadable files", async () => {
    await using tmp = await tmpdir()
    await persist(tmp.path, detail("wf_a", "completed"))
    await persist(tmp.path, detail("wf_b", "error"))
    const torn = path.join(tmp.path, "ses_one", "wf_torn")
    await fs.mkdir(torn, { recursive: true })
    await Bun.write(path.join(torn, WorkflowArchive.FILE), '{"id":"wf_torn",')
    const foreign = path.join(tmp.path, "ses_one", "wf_foreign")
    await fs.mkdir(foreign, { recursive: true })
    await Bun.write(path.join(foreign, WorkflowArchive.FILE), JSON.stringify({ id: "wf_foreign" }))

    const all = await Effect.runPromise(WorkflowArchive.list(tmp.path, "ses_one"))
    expect(all.map((item) => item.id).toSorted()).toEqual(["wf_a", "wf_b"])
    const rest = await Effect.runPromise(WorkflowArchive.list(tmp.path, "ses_one", new Set(["wf_a"])))
    expect(rest.map((item) => item.id)).toEqual(["wf_b"])
    expect(await Effect.runPromise(WorkflowArchive.list(tmp.path, "ses_none"))).toEqual([])
  })

  test("a run whose process is gone reads back as stopped, its unfinished agents skipped", async () => {
    await using tmp = await tmpdir()
    const list = [agent(0, "completed", "Scan"), agent(1, "running", "Scan"), agent(2, "queued", "Scan")]
    const dir = await persist(tmp.path, detail("wf_crashed", "running", list), GONE)
    const mtime = Bun.file(path.join(dir, WorkflowArchive.FILE)).lastModified

    const found = await Effect.runPromise(WorkflowArchive.get(tmp.path, "wf_crashed"))
    expect(found).toMatchObject({ status: "stopped", ended: mtime, running: 0, skipped: 2 })
    expect(found?.list.map((item) => item.status)).toEqual(["completed", "skipped", "skipped"])
    expect(found?.list.map((item) => item.ended)).toEqual([2_000, mtime, mtime])
    expect(found?.phases).toEqual([{ title: "Scan", total: 3, running: 0, done: 0, error: 0, skipped: 2 }])

    // This process's own runs are tracked in memory, so one only on disk is orphaned too.
    await persist(tmp.path, detail("wf_mine", "paused", [agent(0, "queued", "Scan")]))
    expect((await Effect.runPromise(WorkflowArchive.get(tmp.path, "wf_mine")))?.status).toBe("stopped")
  })

  test("a run another live process owns keeps its persisted status", async () => {
    await using tmp = await tmpdir()
    const running = detail("wf_elsewhere", "running", [agent(0, "running", "Scan")])
    await persist(tmp.path, running, process.ppid)
    expect(await Effect.runPromise(WorkflowArchive.get(tmp.path, "wf_elsewhere"))).toEqual(running)
  })

  test("summary drops the detail-only fields", () => {
    const value = detail("wf_sum", "completed", [agent(0, "completed", "Scan")])
    const info = WorkflowArchive.summary(value)
    expect(info).not.toHaveProperty("logs")
    expect(info).not.toHaveProperty("list")
    expect(info).not.toHaveProperty("result")
    expect(info).toMatchObject({ id: "wf_sum", status: "completed", agents: 1, started: 1_000, ended: 3_000 })
  })
})
