// Registry of dynamic workflow runs for one instance (directory), plus their control surface
// (list/get/stop/pause/resume/stopAgent/save) for the workflow tool, the HTTP routes and the clients.
//
// Runs are forked into the instance's InstanceState scope, so they outlive the tool call that launched them and stop
// when the instance is disposed. They are deliberately NOT BackgroundJobs: the session-centric job cancel paths
// (tree cancel on Esc, the background-jobs cancel route) would kill or misroute them. Once a run left memory (server
// restart, instance disposal, retention limit) get and list read its persisted run.json instead.

import path from "path"
import { Context, Effect, Layer, Schema, Scope } from "effect"
import { Global } from "@opencode-ai/core/global"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { WorkflowEvent } from "@opencode-ai/schema/kilocode/workflow-event"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Git } from "@/git"
import { InstanceStore } from "@/project/instance-store"
import { Project } from "@/project/project"
import { Provider } from "@/provider/provider"
import { SessionID, type MessageID } from "@/session/schema"
import { Session } from "@/session/session"
import type { TaskPromptOps } from "@/tool/task"
import { errorMessage } from "@/util/error"
import { Worktree } from "@/worktree"
import { SessionDrain } from "@/kilocode/session/drain"
import { WorkflowArchive } from "./archive"
import { WorkflowJournal } from "./journal"
import { WorkflowMeta } from "./meta"
import { WorkflowRuntime } from "./runtime"
import { WorkflowSandbox } from "./sandbox"
import { WorkflowSaved } from "./saved"
import { WorkflowSpawn } from "./spawn"
import type { Meta, Ref, RunDetail, RunInfo } from "./types"
import { KiloWorkflowEnabled } from "./enabled"

export namespace KiloWorkflow {
  export class Failure extends Schema.TaggedErrorClass<Failure>()("KiloWorkflow.Failure", {
    detail: Schema.String,
  }) {
    override get message() {
      return this.detail
    }
  }

  export type LaunchInput = {
    /** The launching tool call: its session, assistant message and agent. */
    sessionID: SessionID
    messageID: MessageID
    agent: string
    /** Captured from the tool call's ctx.extra.promptOps; used for agents and the completion notification. */
    ops: TaskPromptOps
    /** Full script source (starts with `export const meta`). */
    script: string
    args: unknown
    /** budget.total parsed from the latest human message, or null. */
    total: number | null
    /** Main-loop output tokens spent since that message. */
    main: number
    /** Id of that message: runs launched for the same turn share one budget pool. */
    turn?: string
    /** resumeFromRunId: rerun this session's run, replaying its journal. */
    resume?: string
  }

  export type Launched = { info: RunInfo; meta: Meta; dir: string; script: string }

  export interface Interface {
    readonly launch: (input: LaunchInput) => Effect.Effect<Launched, Failure>
    readonly list: (sessionID?: string) => Effect.Effect<RunInfo[]>
    readonly get: (runID: string) => Effect.Effect<RunDetail | undefined>
    readonly stop: (runID: string) => Effect.Effect<RunInfo | undefined>
    readonly pause: (runID: string) => Effect.Effect<RunInfo | undefined>
    readonly resume: (runID: string) => Effect.Effect<RunInfo | undefined>
    readonly stopAgent: (runID: string, agentID: string) => Effect.Effect<boolean>
    /** Save a run's script.js as a saved workflow; undefined when the run is unknown. */
    readonly save: (runID: string, input: { scope: "project" | "global" }) => Effect.Effect<string | undefined, Failure>
  }

  export class Service extends Context.Service<Service, Interface>()("@kilocode/Workflow") {}

  /** Root of persisted runs: `<data>/workflow/<sessionID>/<runID>/`. */
  export function root() {
    return path.join(Global.Path.data, "workflow")
  }

  export function dir(sessionID: string, runID: string) {
    return path.join(root(), sessionID, runID)
  }

  /** True when `file` lies inside the persisted run directories. */
  export function owned(file: string) {
    const relative = path.relative(root(), path.resolve(file))
    return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative)
  }

  type State = { runs: Map<string, WorkflowRuntime.Run>; scope: Scope.Scope }

  /** Finished runs (and budget pools) remembered per instance. */
  const KEEP = 50

  const read = (file: string) =>
    Effect.tryPromise({
      try: () => Bun.file(file).text(),
      catch: () => new Error(`Cannot read workflow script ${file}`),
    })

  /**
   * Build the service around a spawn function. Production passes WorkflowSpawn.make; tests may pass a fake spawn
   * (and sandbox) to drive runs without a model.
   */
  export const make = Effect.fn("KiloWorkflow.make")(function* (opts: {
    spawn: WorkflowRuntime.Deps["spawn"]
    sandbox?: WorkflowRuntime.Deps["sandbox"]
  }) {
    const sessions = yield* Session.Service
    const config = yield* Config.Service
    const drain = yield* SessionDrain.Service
    const events = yield* EventV2Bridge.Service
    const pools = new Map<string, WorkflowRuntime.Pool>()
    // Runs still in flight in any instance, by id: reads (and the resume guard) reach them from every directory.
    const live = new Map<string, WorkflowRuntime.Run>()

    const state = yield* InstanceState.make<State>(() =>
      Effect.gen(function* () {
        return { runs: new Map(), scope: yield* Scope.Scope }
      }),
    )

    const resolve = (ref: Ref) =>
      Effect.gen(function* () {
        const ctx = yield* InstanceState.context
        if (typeof ref === "string") {
          const directories = yield* config.directories()
          const found = yield* Effect.promise(() =>
            WorkflowSaved.find({ directories, directory: ctx.directory, name: ref }),
          )
          if (!found) return yield* Effect.fail(new Error(`Unknown workflow "${ref}": no saved workflow has that name`))
          return { script: yield* read(found.path), path: found.path }
        }
        if (!ref || typeof ref !== "object" || typeof ref.scriptPath !== "string") {
          return yield* Effect.fail(new Error("workflow() expects a saved workflow name or { scriptPath }"))
        }
        const file = path.resolve(ctx.directory, ref.scriptPath)
        return { script: yield* read(file), path: file }
      })

    // Poll the child session until its first assistant output exists (bounded by the stagger timeout upstream).
    const warm = (sessionID: string) =>
      Effect.gen(function* () {
        const id = SessionID.make(sessionID)
        while (true) {
          const messages = yield* sessions
            .messages({ sessionID: id, limit: 2 })
            .pipe(Effect.catch(() => Effect.succeed([])))
          if (messages.some((item) => item.info.role === "assistant" && item.parts.length > 0)) return
          yield* Effect.sleep(200)
        }
      })

    const notify = (input: LaunchInput, text: string) =>
      Effect.gen(function* () {
        const parent = yield* sessions.get(input.sessionID).pipe(Effect.orDie)
        yield* input.ops.prompt({
          sessionID: input.sessionID,
          agent: parent.agent ?? input.agent,
          ...(parent.model
            ? {
                model: { providerID: parent.model.providerID, modelID: parent.model.id },
                variant: parent.model.variant,
              }
            : {}),
          parts: [{ type: "text", synthetic: true, metadata: { background: true }, text }],
        })
      })

    const pool = (input: LaunchInput) => {
      if (!input.turn) return { main: input.main, agents: 0 }
      const key = `${input.sessionID}:${input.turn}`
      const found = pools.get(key) ?? { main: 0, agents: 0 }
      found.main = Math.max(found.main, input.main)
      pools.set(key, found)
      // Only recent turns can still launch runs; drop the oldest pools.
      for (const stale of [...pools.keys()].slice(0, Math.max(0, pools.size - KEEP))) pools.delete(stale)
      return found
    }

    const launch = Effect.fn("KiloWorkflow.launch")(function* (input: LaunchInput) {
      const parsed = yield* Effect.try({
        try: () => WorkflowMeta.parse(input.script),
        catch: (err) => new Failure({ detail: errorMessage(err) }),
      })
      const registry = yield* InstanceState.get(state)
      const id = input.resume ?? WorkflowRuntime.id()
      const target = dir(input.sessionID, id)
      const prior = registry.runs.get(id) ?? live.get(id)
      const active = (run?: WorkflowRuntime.Run) => {
        if (!run || WorkflowRuntime.terminal(run.info().status)) return undefined
        return new Failure({
          detail: `Workflow run ${id} is still ${run.info().status}. Stop it first (from /workflows) before resuming.`,
        })
      }
      const busy = active(prior)
      if (busy) return yield* busy
      const journal = input.resume ? yield* WorkflowJournal.load(path.join(target, WorkflowJournal.FILE)) : undefined
      if (input.resume && !journal) {
        return yield* new Failure({
          detail: `Workflow run ${id} has nothing to resume: no journal at ${path.join(target, WorkflowJournal.FILE)} (resume works only for runs of this session)`,
        })
      }
      // Another launch may have claimed the id while the journal loaded.
      const raced = active(registry.runs.get(id) ?? live.get(id))
      if (raced) return yield* raced
      const cfg = yield* config.get()
      const run = WorkflowRuntime.make(
        {
          spawn: opts.spawn,
          sandbox: opts.sandbox ?? WorkflowSandbox.start,
          resolve,
          warm,
          publish: (info) => events.publish(WorkflowEvent.Updated, { run: info }),
          notify: (text) => notify(input, text),
          hold: () => drain.hold(input.sessionID),
        },
        {
          id,
          dir: target,
          parent: { sessionID: input.sessionID, messageID: input.messageID, agent: input.agent },
          ops: input.ops,
          script: input.script,
          parsed,
          args: input.args,
          total: input.total,
          pool: pool(input),
          size: KiloWorkflowEnabled.size(cfg).size,
          ...(journal ? { journal } : {}),
        },
      )
      registry.runs.set(id, run)
      live.set(id, run)
      // Keep every active run and the most recent finished ones; their files stay on disk for resume.
      const ended = [...registry.runs.values()].filter((item) => WorkflowRuntime.terminal(item.info().status))
      for (const item of ended.slice(0, Math.max(0, ended.length - KEEP))) registry.runs.delete(item.id)
      yield* run.run.pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (live.get(id) === run) live.delete(id)
          }),
        ),
        Effect.forkIn(registry.scope),
      )
      return { info: run.info(), meta: parsed.meta, dir: target, script: path.join(target, "script.js") }
    })

    const find = (runID: string) => InstanceState.use(state, (registry) => registry.runs.get(runID))

    const list = Effect.fn("KiloWorkflow.list")(function* (sessionID?: string) {
      const registry = yield* InstanceState.get(state)
      const memory = [...registry.runs.values()].map((run) => run.info())
      if (sessionID === undefined) return memory.toSorted((a, b) => a.started - b.started)
      // One session's runs: this instance's, those in flight elsewhere, then the persisted rest.
      const runs = new Map(memory.filter((info) => info.sessionID === sessionID).map((info) => [info.id, info]))
      for (const run of live.values()) {
        const info = run.info()
        if (info.sessionID === sessionID && !runs.has(info.id)) runs.set(info.id, info)
      }
      for (const detail of yield* WorkflowArchive.list(root(), sessionID, new Set(runs.keys()))) {
        runs.set(detail.id, WorkflowArchive.summary(detail))
      }
      return [...runs.values()].toSorted((a, b) => a.started - b.started)
    })

    const get = Effect.fn("KiloWorkflow.get")(function* (runID: string) {
      const run = (yield* find(runID)) ?? live.get(runID)
      if (run) return run.detail()
      return yield* WorkflowArchive.get(root(), runID)
    })

    const control = (name: string, act: (run: WorkflowRuntime.Run) => Effect.Effect<void>) =>
      Effect.fn(`KiloWorkflow.${name}`)(function* (runID: string) {
        const run = yield* find(runID)
        if (!run) return undefined
        yield* act(run)
        return run.info()
      })

    const stopAgent = Effect.fn("KiloWorkflow.stopAgent")(function* (runID: string, agentID: string) {
      const run = yield* find(runID)
      if (!run) return false
      return yield* run.skip(agentID)
    })

    const save = Effect.fn("KiloWorkflow.save")(function* (runID: string, input: { scope: "project" | "global" }) {
      const run = yield* find(runID)
      if (!run) return undefined
      const ctx = yield* InstanceState.context
      const file = path.join(run.dir, "script.js")
      const script = yield* read(file).pipe(Effect.mapError((err) => new Failure({ detail: err.message })))
      // The model may have edited script.js since launch, so the name comes from the file being saved.
      const parsed = yield* Effect.try({
        try: () => WorkflowMeta.parse(script),
        catch: (err) => new Failure({ detail: `${file}: ${errorMessage(err)}` }),
      })
      return yield* Effect.tryPromise({
        try: () =>
          WorkflowSaved.save({
            script,
            name: parsed.meta.name,
            scope: input.scope,
            directory: ctx.directory,
            worktree: ctx.worktree,
            global: Global.Path.config,
          }),
        catch: (err) => new Failure({ detail: errorMessage(err) }),
      })
    })

    return Service.of({
      launch,
      list,
      get,
      stop: control("stop", (run) => run.stop()),
      pause: control("pause", (run) => run.pause()),
      resume: control("resume", (run) => run.resume()),
      stopAgent,
      save,
    })
  })

  export const layer = Layer.effect(
    Service,
    Effect.gen(function* () {
      return yield* make({ spawn: yield* WorkflowSpawn.make })
    }),
  )

  export const node = LayerNode.make({
    service: Service,
    layer,
    deps: [
      Agent.node,
      Session.node,
      Config.node,
      Provider.node,
      SessionDrain.node,
      Database.node,
      InstanceStore.node,
      Git.node,
      Worktree.node,
      Project.node,
      EventV2Bridge.node,
    ],
  })
}
