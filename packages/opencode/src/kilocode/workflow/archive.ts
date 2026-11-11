// Persisted workflow runs read back from `<root>/<sessionID>/<runID>/run.json`. The service falls back to these
// once a run left memory (server restart, instance disposal, or the per-instance retention limit), so the HTTP
// routes and the clients still show its final state.

import fs from "fs/promises"
import path from "path"
import { Effect, Option, Result, Schema } from "effect"
import * as Log from "@opencode-ai/core/util/log"
import { WorkflowEvent } from "@opencode-ai/schema/kilocode/workflow-event"
import type { AgentInfo, RunDetail, RunInfo } from "./types"

const log = Log.create({ service: "workflow.archive" })

export namespace WorkflowArchive {
  export const FILE = "run.json"

  const decode = Schema.decodeUnknownOption(WorkflowEvent.RunDetail)

  /** Ids name directories, so anything that could step outside the root is never a run. */
  function safe(id: string) {
    return /^[A-Za-z0-9_-]+$/.test(id)
  }

  /** The run.json body: the run's detail plus the pid of the process running it (to spot orphaned runs). */
  export function record(detail: RunDetail) {
    return { ...detail, pid: process.pid }
  }

  function code(err: unknown) {
    if (!err || typeof err !== "object" || !("code" in err)) return undefined
    return err.code
  }

  /** True when another live process runs it; this process's own runs are tracked in memory instead. */
  function elsewhere(pid: unknown) {
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false
    const probe = Result.try({ try: () => process.kill(pid, 0), catch: (err) => err })
    return Result.isSuccess(probe) || code(probe.failure) === "EPERM"
  }

  /** A persisted run whose process is gone: unfinished state is reported stopped and its live agents skipped. */
  export function orphan(detail: RunDetail, ended: number): RunDetail {
    if (detail.status === "completed" || detail.status === "error" || detail.status === "stopped") return detail
    const list = detail.list.map(
      (item): AgentInfo =>
        item.status === "queued" || item.status === "running"
          ? { ...item, status: "skipped", ended: item.ended ?? ended }
          : item,
    )
    const skipped = (items: AgentInfo[]) => items.filter((item) => item.status === "skipped").length
    return {
      ...detail,
      status: "stopped",
      ended: detail.ended ?? ended,
      running: 0,
      skipped: skipped(list),
      phases: detail.phases.map((phase) => {
        const items = list.filter((item) => (item.group ?? item.phase) === phase.title)
        return { ...phase, running: 0, skipped: skipped(items) }
      }),
      list,
    }
  }

  /** The summary of a detail, as lists and events carry it. */
  export function summary(detail: RunDetail): RunInfo {
    const info: RunInfo & Partial<Pick<RunDetail, "logs" | "list" | "result">> = { ...detail }
    delete info.logs
    delete info.list
    delete info.result
    return info
  }

  /** One run directory's run.json, or undefined when it is missing or unreadable. */
  export const read = Effect.fn("WorkflowArchive.read")(function* (dir: string) {
    const file = path.join(dir, FILE)
    const source = Bun.file(file)
    const text = yield* Effect.tryPromise(() => source.text()).pipe(Effect.option)
    if (Option.isNone(text)) return undefined
    const parsed = Result.try({ try: () => JSON.parse(text.value) as unknown, catch: (err) => err })
    if (Result.isFailure(parsed)) {
      log.warn("skipping unreadable workflow run file", { file, error: String(parsed.failure) })
      return undefined
    }
    const found = decode(parsed.success)
    if (Option.isNone(found)) {
      log.warn("skipping malformed workflow run file", { file })
      return undefined
    }
    const value = found.value
    const detail: RunDetail = { ...value, phases: [...value.phases], logs: [...value.logs], list: [...value.list] }
    const raw = parsed.success
    if (raw && typeof raw === "object" && "pid" in raw && elsewhere(raw.pid)) return detail
    return orphan(detail, source.lastModified)
  })

  /** Directory names under `dir`, or none when it does not exist. */
  const names = (dir: string) =>
    Effect.promise(() =>
      fs.readdir(dir, { withFileTypes: true }).then(
        (items) => items.filter((item) => item.isDirectory() && safe(item.name)).map((item) => item.name),
        () => [] as string[],
      ),
    )

  /** One persisted run by id: under `sessionID` when known, else under whichever session directory holds it. */
  export const get = Effect.fn("WorkflowArchive.get")(function* (root: string, runID: string, sessionID?: string) {
    if (!safe(runID) || (sessionID !== undefined && !safe(sessionID))) return undefined
    if (sessionID !== undefined) return yield* read(path.join(root, sessionID, runID))
    const sessions = yield* names(root)
    const hits = yield* Effect.forEach(
      sessions,
      (session) => Effect.promise(() => Bun.file(path.join(root, session, runID, FILE)).exists()),
      { concurrency: 32 },
    )
    const session = sessions.find((_, index) => hits.at(index))
    if (session === undefined) return undefined
    return yield* read(path.join(root, session, runID))
  })

  /** Every persisted run of one session, except the `known` run ids (their files are not read). */
  export const list = Effect.fn("WorkflowArchive.list")(function* (
    root: string,
    sessionID: string,
    known: ReadonlySet<string> = new Set(),
  ) {
    if (!safe(sessionID)) return []
    const dir = path.join(root, sessionID)
    const runs = (yield* names(dir)).filter((run) => !known.has(run))
    const found = yield* Effect.forEach(runs, (run) => read(path.join(dir, run)), { concurrency: 8 })
    return found.filter((item): item is RunDetail => item !== undefined)
  })
}
