// One dynamic workflow run: the sandboxed script plus the host side of its agent()/workflow()/log()/phase() calls.
//
// The runtime owns the run's lifecycle (concurrency cap, pause gate, journal replay, budget ceiling, prefix stagger,
// progress snapshots, persisted files and the completion <task-notification>). Everything that touches sessions,
// models or the event bus is injected through `Deps`, so it can be driven with a fake spawn in tests.

import os from "os"
import path from "path"
import fs from "fs/promises"
import { Cause, Deferred, Effect, Exit, Fiber, Latch, Result, Semaphore } from "effect"
import * as Log from "@opencode-ai/core/util/log"
import { EffectBridge } from "@/effect/bridge"
import type { TaskPromptOps } from "@/tool/task"
import { errorMessage } from "@/util/error"
import { WorkflowArchive } from "./archive"
import { WorkflowJournal } from "./journal"
import { WorkflowMeta } from "./meta"
import type { WorkflowSandbox } from "./sandbox"
import { WorkflowSpawn } from "./spawn"
import type {
  AgentInfo,
  AgentOpts,
  Call,
  Outcome,
  PhaseInfo,
  Ref,
  RunDetail,
  RunInfo,
  Size,
  Status,
  Tokens,
} from "./types"

const log = Log.create({ service: "workflow.runtime" })

export namespace WorkflowRuntime {
  /** Agents one run may start over its lifetime, nested workflows included (a runaway-loop backstop). */
  export const MAX_AGENTS = 1000
  /** Result characters inlined into the completion notification. */
  export const RESULT_LIMIT = 20_000
  /** Progress snapshots are published at most this often (≤4/s); status changes publish immediately. */
  export const TICK = 250
  /** Ticks between refreshes of the main loop's share of budget.spent() (runs with a budget only). */
  const REFRESH = 8
  const PREVIEW = 2000
  const LOGS = 1000

  /** Concurrent agent() calls per run: KILO_WORKFLOW_MAX_CONCURRENT_AGENTS (1..256), else min(16, CPUs - 2). */
  export function concurrency() {
    const value = Number(process.env.KILO_WORKFLOW_MAX_CONCURRENT_AGENTS)
    if (Number.isInteger(value) && value >= 1 && value <= 256) return value
    return Math.min(16, Math.max(1, os.availableParallelism() - 2))
  }

  /** How long an agent waits for a same-shaped sibling to warm the provider prompt cache (0 disables). */
  export function stagger() {
    const raw = process.env.KILO_WORKFLOW_PREFIX_STAGGER_MS
    const value = Number(raw)
    if (raw && Number.isFinite(value) && value >= 0) return value
    return 5000
  }

  /** Shape of every run id (see `id`). */
  export const ID = /^wf_[0-9a-f]{8}-[0-9a-f]{3}$/

  /** Run id: `wf_<8 hex>-<3 hex>`. */
  export function id() {
    const hex = Buffer.from(crypto.getRandomValues(new Uint8Array(6))).toString("hex")
    return `wf_${hex.slice(0, 8)}-${hex.slice(8, 11)}`
  }

  /**
   * Token pool behind budget.spent(): main-loop output tokens since the user's budget directive plus the output
   * (and reasoning) tokens of every workflow agent launched for that turn. Runs of the same turn share one pool.
   */
  export type Pool = { main: number; agents: number }

  export type Deps = {
    /** One agent() call → its outcome (WorkflowSpawn.make in production). Interrupting it skips the agent. */
    spawn: (input: WorkflowSpawn.Input) => Effect.Effect<Outcome>
    /** Sandbox host for the script (WorkflowSandbox.start in production). */
    sandbox: (input: WorkflowSandbox.Input) => WorkflowSandbox.Handle
    /** Resolve a nested workflow() reference to its source; fails with a message the script sees. */
    resolve: (ref: Ref) => Effect.Effect<{ script: string; path: string }, Error>
    /** Completes once the given child session has assistant output (drives the prefix stagger). */
    warm: (sessionID: string) => Effect.Effect<void>
    /** Publish a progress snapshot (workflow.run.updated). */
    publish: (info: RunInfo) => Effect.Effect<void>
    /** Inject a <task-notification> into the launching session. */
    notify: (text: string) => Effect.Effect<void>
    /**
     * Deliver the stopped notification of a run whose instance went away (a server reload): the session is still
     * there, but the run's own instance is not, so this must not block and must not run in that instance.
     */
    orphan: (text: string) => Effect.Effect<void>
    /** Keep the launching session busy (SessionDrain.hold); returns the release. */
    hold: () => Effect.Effect<() => void>
    /** Token ledger of a child session, for agents interrupted before they reported their outcome. */
    usage: (sessionID: string) => Effect.Effect<{ tokens: Tokens; tools: number }>
    /** Main-loop output tokens spent so far this turn (the launch value is only a snapshot). */
    main: () => Effect.Effect<number>
  }

  export type Input = {
    id: string
    /** Run directory: `<data>/workflow/<sessionID>/<runID>`. */
    dir: string
    parent: WorkflowSpawn.Input["parent"]
    ops: TaskPromptOps
    /** Full script source, persisted as script.js. */
    script: string
    parsed: WorkflowMeta.Parsed
    args: unknown
    /** budget.total: the turn's token target, or null. */
    total: number | null
    pool: Pool
    size: Size
    /** Previous run's journal when resuming (resumeFromRunId). */
    journal?: ReadonlyArray<WorkflowJournal.Entry>
    concurrency?: number
    /** Prefix stagger in ms (defaults to KILO_WORKFLOW_PREFIX_STAGGER_MS / 5000). */
    stagger?: number
  }

  export type Run = {
    readonly id: string
    readonly dir: string
    info(): RunInfo
    detail(): RunDetail
    /** The run itself; fork it into a long-lived scope. Completes after the completion notification. */
    readonly run: Effect.Effect<void>
    /** Completes once the run reached a terminal status and wrote its files (before the notification). */
    readonly done: Effect.Effect<void>
    /** True once `done` completed: every agent has exited and the journal is final, so the run may be relaunched. */
    settled(): boolean
    stop(): Effect.Effect<void>
    pause(): Effect.Effect<void>
    resume(): Effect.Effect<void>
    /** Stop one agent: the script receives null for it and it is not journaled. */
    skip(agentID: string): Effect.Effect<boolean>
  }

  /** Where a script call came from: the top-level script, or a nested workflow() child. */
  type Frame = { nested: boolean; group?: string }

  /** What the script receives for one agent() call: a value (null included) or a thrown error. */
  type Reply = { ok: true; value: unknown } | { ok: false; error: string }

  export function terminal(status: Status) {
    return status === "completed" || status === "error" || status === "stopped"
  }

  /** A result as text: strings verbatim, everything else as JSON. */
  export function text(value: unknown) {
    if (value === undefined) return ""
    if (typeof value === "string") return value
    return JSON.stringify(value, null, 2) ?? ""
  }

  function empty(value: unknown) {
    return value == null || (typeof value === "string" && value.trim().length === 0)
  }

  /** Display label: opts.label, else the first 40 characters of the prompt, else `agent-<index>`. */
  export function label(prompt: string, opts: AgentOpts, index: number) {
    if (typeof opts.label === "string" && opts.label.trim()) return opts.label
    return prompt.replace(/\s+/g, " ").trim().slice(0, 40) || `agent-${index}`
  }

  const SUMMARY: Record<Exclude<Status, "running">, string> = {
    completed: "completed",
    error: "failed",
    stopped: "was stopped",
    paused: "was paused",
  }

  const NOTE: Partial<Record<Status, string>> = {
    stopped: "Stopped by the user before the script finished.",
    paused:
      "Paused by the user: agents already running finish, but no new agent() calls start until the run is resumed from /workflows.",
  }

  /** Why a run stopped when its instance was disposed (config change, provider login, ...) rather than by the user. */
  export const RELOADED =
    "Stopped because the Kilo server reloaded (for example after a settings change) before the script finished. Agents still running were stopped; resume with resumeFromRunId to replay the ones that completed."

  /** The <task-notification> injected into the launching session when a run completes, fails, stops or pauses. */
  export function notification(detail: RunDetail, input: { empty: number; now: number; note?: string }) {
    const status = detail.status === "running" ? "completed" : detail.status
    const output = path.join(detail.dir, "output.json")
    const raw =
      status === "error"
        ? (detail.error_message ?? "")
        : status === "completed"
          ? (detail.result ?? "")
          : (input.note ?? NOTE[status] ?? "")
    const result =
      raw.length > RESULT_LIMIT
        ? `${raw.slice(0, RESULT_LIMIT)}... (truncated ${raw.length - RESULT_LIMIT} chars, full result in ${output})`
        : raw
    const done = detail.list.filter((item) => item.status === "completed" || item.status === "cached").length
    const usage = [
      `<agent_count>${detail.list.length}</agent_count>`,
      `<agents_done>${done}</agents_done>`,
      `<agents_error>${detail.error}</agents_error>`,
      `<agents_skipped>${detail.skipped}</agents_skipped>`,
      `<agents_empty_result>${input.empty}</agents_empty_result>`,
      `<subagent_tokens>${detail.tokens}</subagent_tokens>`,
      `<tool_uses>${detail.tools}</tool_uses>`,
      `<duration_ms>${Math.max(0, (detail.ended ?? input.now) - detail.started)}</duration_ms>`,
    ].join("")
    const script = path.join(detail.dir, "script.js")
    return [
      "<task-notification>",
      `<task-id>${detail.id}</task-id>`,
      `<output-file>${output}</output-file>`,
      `<status>${status}</status>`,
      `<summary>Dynamic workflow "${detail.description}" ${SUMMARY[status]}</summary>`,
      `<result>${result}</result>`,
      `<diagnostics>Per-agent results: ${path.join(detail.dir, WorkflowJournal.FILE)} — one {"type":"result",...} line per completed agent with its full return value.`,
      "If the result above is empty or unexpected, Read this file BEFORE diagnosing — do not assume agents returned non-empty results.",
      `To re-run with edited post-processing: workflow({scriptPath: '${script}', resumeFromRunId: '${detail.id}'}) — agents whose (prompt, opts) are unchanged replay from cache.</diagnostics>`,
      `<usage>${usage}</usage>`,
      "</task-notification>",
    ].join("\n")
  }

  export function make(deps: Deps, input: Input): Run {
    const meta = input.parsed.meta
    const script = path.join(input.dir, "script.js")
    const width = input.concurrency ?? concurrency()
    const wait = input.stagger ?? stagger()
    const state = {
      status: "running" as Status,
      error: undefined as string | undefined,
      started: Date.now(),
      ended: undefined as number | undefined,
      value: undefined as unknown,
      result: undefined as string | undefined,
      count: 0,
      dirty: false,
      stale: false,
      ticks: 0,
      /** Set once the whole run is stopping: agents interrupted from then on are journaled as pending. */
      halting: false,
      /** Set once the final notification was handed off, so a later interrupt never sends a second one. */
      notified: false,
      release: undefined as (() => void) | undefined,
      bridge: undefined as EffectBridge.Shape | undefined,
    }
    const agents: AgentInfo[] = []
    const logs: string[] = []
    const blank = new Set<string>()
    const titles = meta.phases.map((item) => item.title)
    const details = new Map(meta.phases.map((item) => [item.title, item.detail]))
    const live = new Map<string, Fiber.Fiber<Reply>>()
    const boxes = new Set<WorkflowSandbox.Handle>()
    const leaders = new Map<string, Deferred.Deferred<void>>()
    const gate = Latch.makeUnsafe(true)
    const lock = Semaphore.makeUnsafe(width)
    // run.json writes never overlap, so a periodic save can't land after the final one.
    const saving = Semaphore.makeUnsafe(1)
    const replay = WorkflowJournal.replay(input.journal ?? [])
    // A resumed run stages its journal, so a hard kill midway leaves the previous one intact (see WorkflowJournal).
    const journal = WorkflowJournal.writer(path.join(input.dir, WorkflowJournal.FILE), {
      staged: input.journal !== undefined,
    })
    const finished = Deferred.makeUnsafe<void>()

    const mark = () => {
      state.dirty = true
      state.stale = true
    }

    const title = (name: string) => {
      if (!titles.includes(name)) titles.push(name)
    }

    const spent = () => input.pool.main + input.pool.agents

    const push = () => {
      const value = spent()
      for (const box of boxes) box.spent(value)
    }

    const release = () => {
      const done = state.release
      state.release = undefined
      done?.()
    }

    const phases = (): PhaseInfo[] =>
      titles.map((name) => {
        const items = agents.filter((item) => (item.group ?? item.phase) === name)
        const count = (status: AgentInfo["status"][]) => items.filter((item) => status.includes(item.status)).length
        return {
          title: name,
          ...(details.get(name) ? { detail: details.get(name) } : {}),
          total: items.length,
          running: count(["running"]),
          done: count(["completed", "cached"]),
          error: count(["error"]),
          skipped: count(["skipped"]),
        }
      })

    const info = (): RunInfo => {
      const count = (status: AgentInfo["status"][]) => agents.filter((item) => status.includes(item.status)).length
      return {
        id: input.id,
        sessionID: input.parent.sessionID,
        name: meta.name,
        description: meta.description,
        status: state.status,
        phases: phases(),
        agents: agents.length,
        running: count(["running"]),
        // `done` counts cached replays too; `cached` is the replayed subset.
        done: count(["completed", "cached"]),
        error: count(["error"]),
        skipped: count(["skipped"]),
        cached: count(["cached"]),
        tokens: agents.reduce((sum, item) => sum + item.tokens, 0),
        tools: agents.reduce((sum, item) => sum + item.tools, 0),
        size: input.size,
        started: state.started,
        ...(state.ended === undefined ? {} : { ended: state.ended }),
        dir: input.dir,
        script,
        ...(state.error === undefined ? {} : { error_message: state.error }),
      }
    }

    const detail = (): RunDetail => ({
      ...info(),
      logs: [...logs],
      list: agents.map((item) => ({ ...item })),
      ...(state.result === undefined ? {} : { result: state.result }),
    })

    const publish = Effect.suspend(() => {
      state.dirty = false
      return deps.publish(info())
    }).pipe(Effect.catchCause((cause) => Effect.sync(() => log.warn("workflow progress publish failed", { cause }))))

    const write = (file: string, body: unknown) =>
      Effect.tryPromise(() => Bun.write(path.join(input.dir, file), JSON.stringify(body, null, 2))).pipe(
        Effect.catch((err) => Effect.sync(() => log.warn("failed to write workflow file", { file, err }))),
        Effect.asVoid,
      )

    const save = saving.withPermits(1)(
      Effect.suspend(() => {
        state.stale = false
        return write(WorkflowArchive.FILE, WorkflowArchive.record(detail()))
      }),
    )

    /** Fold the main loop's tokens since launch into budget.spent(); only a budget ceiling depends on them. */
    const refresh = Effect.gen(function* () {
      if (input.total === null || terminal(state.status)) return
      const main = yield* deps.main().pipe(Effect.catchCause(() => Effect.succeed(0)))
      if (main <= input.pool.main) return
      input.pool.main = main
      push()
    })

    const tick = Effect.gen(function* () {
      state.ticks += 1
      if (state.dirty) yield* publish
      if (state.stale && state.ticks % 4 === 0) yield* save
      if (state.ticks % REFRESH === 0) yield* refresh
    })

    const notify = (text: string) =>
      deps
        .notify(text)
        .pipe(
          Effect.catchCause((cause) =>
            Effect.sync(() => log.error("failed to deliver workflow notification", { run: input.id, cause })),
          ),
        )

    /** The final notification: sent at most once per run. */
    const announce = (deliver: (text: string) => Effect.Effect<void>, note?: string) =>
      Effect.suspend(() => {
        if (state.notified) return Effect.void
        state.notified = true
        return deliver(notification(detail(), { empty: blank.size, now: Date.now(), ...(note ? { note } : {}) }))
      })

    /** Tokens of an agent interrupted before it reported an outcome still count toward the run and the budget. */
    const fold = (item: AgentInfo) =>
      Effect.suspend(() => {
        const id = item.sessionID
        if (!id) return Effect.void
        return deps.usage(id).pipe(
          Effect.map((spent) => {
            item.tokens = spent.tokens.total
            item.tools = spent.tools
            input.pool.agents += spent.tokens.output + spent.tokens.reasoning
            push()
          }),
          Effect.catchCause((cause) =>
            Effect.sync(() => log.warn("failed to read interrupted workflow agent usage", { agent: item.id, cause })),
          ),
        )
      })

    const settle = (item: AgentInfo, key: string, outcome: Outcome) =>
      Effect.gen(function* () {
        item.tokens = outcome.tokens.total
        item.tools = outcome.tools
        item.ended = Date.now()
        if (outcome.sessionID) item.sessionID = outcome.sessionID
        if (outcome.worktree) item.worktree = outcome.worktree
        if (outcome.warning) logs.push(`${item.label}: ${outcome.warning}`)
        input.pool.agents += outcome.tokens.output + outcome.tokens.reasoning
        push()
        mark()
        if (outcome.status === "completed") {
          item.status = "completed"
          item.result = text(outcome.value).slice(0, PREVIEW)
          item.model = `${outcome.model.providerID}/${outcome.model.modelID}`
          if (outcome.variant) item.variant = outcome.variant
          if (empty(outcome.value)) blank.add(item.id)
          yield* journal.append({
            type: "result",
            index: item.index,
            key,
            label: item.label,
            ...(item.phase === undefined ? {} : { phase: item.phase }),
            value: outcome.value,
          })
          return { ok: true, value: outcome.value } satisfies Reply
        }
        if (outcome.status === "skipped") {
          item.status = "skipped"
          return { ok: true, value: null } satisfies Reply
        }
        item.status = "error"
        item.error = outcome.error
        // Terminal API/provider failures hand the script null; everything else throws from agent().
        if (outcome.terminal) return { ok: true, value: null } satisfies Reply
        return { ok: false, error: outcome.error } satisfies Reply
      })

    /** Prefix stagger: hold an agent while a same-shaped sibling has started but produced no output yet. */
    const staggered = (opts: AgentOpts) =>
      Effect.gen(function* () {
        if (wait <= 0) return undefined
        const shape = WorkflowJournal.hash([
          opts.model ?? null,
          opts.effort ?? null,
          opts.agentType ?? WorkflowSpawn.AGENT,
          opts.schema ? WorkflowJournal.hash(opts.schema) : null,
          opts.isolation ?? null,
        ])
        const leader = leaders.get(shape)
        if (!leader) {
          const own = Deferred.makeUnsafe<void>()
          leaders.set(shape, own)
          return own
        }
        if (!Deferred.isDoneUnsafe(leader)) {
          yield* Deferred.await(leader).pipe(Effect.timeoutOption(wait))
          if (terminal(state.status)) return yield* Effect.interrupt
        }
        return undefined
      })

    const work = (item: AgentInfo, key: string, prompt: string, opts: AgentOpts) => {
      const held: { leader?: Deferred.Deferred<void>; watch?: Fiber.Fiber<void> } = {}
      return Effect.gen(function* () {
        held.leader = yield* staggered(opts)
        return yield* lock.withPermits(1)(
          Effect.gen(function* () {
            yield* gate.await
            item.status = "running"
            item.started = Date.now()
            mark()
            const outcome = yield* deps.spawn({
              parent: input.parent,
              ops: input.ops,
              run: { id: input.id, name: meta.name },
              agent: { id: item.id, index: item.index, label: item.label, prompt, opts },
              onSession: (sessionID) => {
                item.sessionID = sessionID
                mark()
                const leader = held.leader
                if (!leader || !state.bridge) return
                held.watch = state.bridge.fork(
                  deps.warm(sessionID).pipe(Effect.andThen(Deferred.succeed(leader, undefined)), Effect.asVoid),
                )
              },
            })
            return yield* settle(item, key, outcome)
          }),
        )
      }).pipe(
        Effect.onInterrupt(() =>
          Effect.gen(function* () {
            item.status = "skipped"
            item.ended = Date.now()
            mark()
            yield* fold(item)
            // Stopping the whole run counts no agent as failed: on resume this one starts over, while the agents
            // after it still replay. Stopping just this agent (skip) records nothing, so a resume reruns from here.
            if (state.halting) yield* journal.append({ type: "pending", index: item.index, key })
          }),
        ),
        Effect.catchDefect((defect) =>
          Effect.sync((): Reply => {
            item.status = "error"
            item.error = errorMessage(defect)
            item.ended = Date.now()
            mark()
            return { ok: false, error: item.error }
          }),
        ),
        Effect.ensuring(
          Effect.suspend(() => {
            if (held.leader) Deferred.doneUnsafe(held.leader, Effect.void)
            return held.watch ? Fiber.interrupt(held.watch) : Effect.void
          }),
        ),
      )
    }

    const agent = (frame: Frame, prompt: string, opts: AgentOpts): Promise<unknown> => {
      const bridge = state.bridge
      if (!bridge || terminal(state.status)) return Promise.resolve(null)
      if (state.count >= MAX_AGENTS) {
        return Promise.reject(
          new Error(
            `agent() limit reached: a workflow run may start at most ${MAX_AGENTS} agents (nested workflows included)`,
          ),
        )
      }
      if (input.total !== null && spent() >= input.total) {
        return Promise.reject(
          new Error(
            `Token budget exhausted: budget.spent() is ${spent()} of budget.total ${input.total}, so no further agent() calls can start`,
          ),
        )
      }
      const invalid = WorkflowSpawn.check(opts)
      if (invalid) return Promise.reject(new Error(invalid))

      const index = state.count
      state.count += 1
      const item: AgentInfo = {
        id: `a${index}`,
        index,
        label: label(prompt, opts, index),
        ...(opts.phase === undefined ? {} : { phase: opts.phase }),
        ...(frame.group === undefined ? {} : { group: frame.group }),
        status: "queued",
        agentType: opts.agentType ?? WorkflowSpawn.AGENT,
        tokens: 0,
        tools: 0,
        prompt,
      }
      agents.push(item)
      if (!frame.group && opts.phase) title(opts.phase)
      mark()

      const key = WorkflowJournal.key(prompt, opts)
      const hit = replay.take(key)
      if (hit) {
        const now = Date.now()
        Object.assign(item, { status: "cached", started: now, ended: now, result: text(hit.value).slice(0, PREVIEW) })
        if (empty(hit.value)) blank.add(item.id)
        // A resumed run rewrites the journal, so served cache entries are recorded again for the next resume.
        bridge.fork(
          journal.append({
            type: "result",
            index,
            key,
            label: item.label,
            ...(item.phase === undefined ? {} : { phase: item.phase }),
            value: hit.value,
          }),
        )
        return Promise.resolve(hit.value)
      }

      const reply = Promise.withResolvers<unknown>()
      const fiber = bridge.fork(work(item, key, prompt, opts))
      live.set(item.id, fiber)
      fiber.addObserver((exit) => {
        live.delete(item.id)
        if (Exit.isFailure(exit)) return reply.resolve(null)
        if (exit.value.ok) return reply.resolve(exit.value.value)
        reply.reject(new Error(exit.value.error))
      })
      return reply.promise
    }

    const nested = (frame: Frame, ref: Ref, args: unknown) =>
      Effect.gen(function* () {
        if (frame.nested) {
          return yield* Effect.fail(
            new Error("Nesting is one level only: workflow() cannot be called from inside a nested workflow"),
          )
        }
        if (terminal(state.status)) return yield* Effect.fail(new Error("workflow run is no longer active"))
        const found = yield* deps.resolve(ref)
        const parsed = yield* Effect.try({
          try: () => WorkflowMeta.parse(found.script),
          catch: (err) => new Error(`${found.path}: ${errorMessage(err)}`),
        })
        const group = `▸ ${parsed.meta.name}`
        title(group)
        mark()
        const box = deps.sandbox({
          body: parsed.body,
          args,
          total: input.total,
          file: found.path,
          onCall: handler({ nested: true, group }),
        })
        boxes.add(box)
        box.spent(spent())
        const result = yield* Effect.promise(() => box.result).pipe(
          Effect.onInterrupt(() => Effect.sync(() => box.terminate())),
          Effect.ensuring(Effect.sync(() => boxes.delete(box))),
        )
        if (!result.ok) return yield* Effect.fail(new Error(result.error))
        return result.value
      })

    const handler =
      (frame: Frame) =>
      (call: Call): Promise<unknown> => {
        if (call.method === "log") {
          logs.push(frame.group ? `${frame.group}: ${call.message}` : call.message)
          if (logs.length > LOGS) logs.splice(0, logs.length - LOGS)
          mark()
          return Promise.resolve(undefined)
        }
        if (call.method === "phase") {
          if (!frame.nested) title(call.title)
          mark()
          return Promise.resolve(undefined)
        }
        if (call.method === "agent") return agent(frame, call.prompt, call.opts ?? {})
        const bridge = state.bridge
        if (!bridge) return Promise.resolve(null)
        return bridge.promise(Effect.result(nested(frame, call.ref, call.args))).then((result) => {
          if (Result.isSuccess(result)) return result.success
          throw result.failure
        })
      }

    /** Stop everything still in flight (script sandboxes first, so no new agent() calls start). */
    const halt = Effect.suspend(() => {
      state.halting = true
      for (const box of boxes) box.terminate()
      return Fiber.interruptAll([...live.values()])
    })

    /** A resumed run keeps the previous journal's results it never reached, then replaces the journal with its own. */
    const keep = journal.restore(input.journal ?? []).pipe(Effect.andThen(journal.commit()))

    const finish = (result: WorkflowSandbox.Result) =>
      Effect.gen(function* () {
        // Agents the script never awaited are moot once it returned.
        yield* halt
        yield* keep
        if (state.status !== "stopped") state.status = result.ok ? "completed" : "error"
        if (!result.ok && state.status === "error") state.error = result.error
        if (result.ok) {
          state.value = result.value
          state.result = text(result.value)
        }
        state.ended = Date.now()
        yield* save
        yield* write("output.json", {
          summary: `Dynamic workflow "${meta.description}" ${SUMMARY[state.status]}`,
          agentCount: agents.length,
          logs,
          result: state.value ?? null,
          ...(state.error === undefined ? {} : { error: state.error }),
        })
        yield* publish
        yield* Deferred.succeed(finished, undefined)
        yield* announce(notify)
      })

    const run = Effect.gen(function* () {
      state.bridge = yield* EffectBridge.make()
      state.release = yield* deps.hold()
      yield* Effect.promise(() => fs.mkdir(input.dir, { recursive: true }))
      yield* Effect.promise(() => Bun.write(script, input.script))
      yield* journal.reset()
      yield* save
      yield* publish
      yield* Effect.sleep(TICK).pipe(Effect.andThen(tick), Effect.forever, Effect.forkScoped)
      const box = deps.sandbox({
        body: input.parsed.body,
        args: input.args,
        total: input.total,
        file: script,
        onCall: handler({ nested: false }),
      })
      boxes.add(box)
      box.spent(spent())
      const result = yield* Effect.promise(() => box.result)
      boxes.delete(box)
      yield* finish(result)
    }).pipe(
      Effect.scoped,
      Effect.onInterrupt(() =>
        Effect.gen(function* () {
          // The owning instance went away (a server reload), the session did not: record and publish what
          // happened, then tell the model from outside this instance.
          yield* halt
          yield* keep
          if (!terminal(state.status)) state.status = "stopped"
          state.ended ??= Date.now()
          yield* save
          yield* publish
          yield* Deferred.succeed(finished, undefined)
          yield* announce(
            (text) =>
              deps
                .orphan(text)
                .pipe(
                  Effect.catchCause((cause) =>
                    Effect.sync(() => log.error("failed to hand off workflow notification", { run: input.id, cause })),
                  ),
                ),
            RELOADED,
          )
        }),
      ),
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.gen(function* () {
              log.error("workflow run failed", { run: input.id, cause })
              yield* halt
              yield* keep
              state.status = "error"
              state.error = errorMessage(Cause.squash(cause))
              state.ended ??= Date.now()
              yield* save
              yield* publish
              yield* Deferred.succeed(finished, undefined)
              yield* announce(notify)
            }),
      ),
      Effect.ensuring(Effect.sync(release)),
    )

    const stop = () =>
      Effect.gen(function* () {
        if (terminal(state.status)) return
        state.status = "stopped"
        yield* halt
        yield* publish
      })

    const pause = () =>
      Effect.gen(function* () {
        if (state.status !== "running") return
        state.status = "paused"
        Latch.closeUnsafe(gate)
        yield* publish
        const done = state.release
        state.release = undefined
        const text = notification(detail(), { empty: blank.size, now: Date.now() })
        // Release the hold only after the paused notification is queued, so `kilo run` still sees it.
        const deliver = notify(text).pipe(Effect.ensuring(Effect.sync(() => done?.())))
        if (state.bridge) state.bridge.fork(deliver)
      })

    const resume = () =>
      Effect.gen(function* () {
        if (state.status !== "paused") return
        state.release = yield* deps.hold()
        state.status = "running"
        Latch.openUnsafe(gate)
        yield* publish
      })

    const skip = (agentID: string) =>
      Effect.gen(function* () {
        const fiber = live.get(agentID)
        if (!fiber) return false
        yield* Fiber.interrupt(fiber)
        return true
      })

    return {
      id: input.id,
      dir: input.dir,
      info,
      detail,
      run,
      done: Deferred.await(finished),
      settled: () => Deferred.isDoneUnsafe(finished),
      stop,
      pause,
      resume,
      skip,
    }
  }
}
