// One workflow `agent(prompt, opts)` call → one child session of the launching session.
//
// Mirrors the Task tool's child-session recipe (model resolution, inherited permission ceilings,
// sandbox inheritance, drain linking, cost propagation) but returns the agent's raw final text, or
// with `opts.schema` its locally validated StructuredOutput value, re-prompting on a miss.

import { Cause, Effect, Exit, Result } from "effect"
import * as Log from "@opencode-ai/core/util/log"
import { Database } from "@opencode-ai/core/database/database"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Agent } from "@/agent/agent"
import { deriveSubagentSessionPermission } from "@/agent/subagent-permissions"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import { Git } from "@/git"
import { Permission } from "@/permission"
import { InstanceStore } from "@/project/instance-store"
import { Project } from "@/project/project"
import { Provider } from "@/provider/provider"
import { MessageV2 } from "@/session/message-v2"
import { MessageID, SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import type { TaskPromptOps } from "@/tool/task"
import { errorMessage } from "@/util/error"
import { Worktree } from "@/worktree"
import { WORKFLOW_SUBAGENT } from "@/kilocode/agent"
import { KiloSession } from "@/kilocode/session"
import { KiloCostPropagation } from "@/kilocode/session/cost-propagation"
import { SessionDrain } from "@/kilocode/session/drain"
import * as SandboxPolicy from "@/kilocode/sandbox/policy"
import { KiloTask } from "@/kilocode/tool/task"
import { KiloTaskBackgroundProcess } from "@/kilocode/tool/task-background-process"
import { WorkflowEffort } from "./effort"
import { WorkflowPrompts } from "./prompts"
import { WorkflowSchema } from "./schema"
import type { AgentOpts, Outcome, Tokens } from "./types"
import { WorkflowWorktree } from "./worktree"

const log = Log.create({ service: "workflow.spawn" })

export namespace WorkflowSpawn {
  export type Input = {
    /** The tool call that launched the run (parent session context). */
    parent: { sessionID: string; messageID: string; agent: string }
    /** Captured from the launching tool call's ctx.extra.promptOps. */
    ops: TaskPromptOps
    run: { id: string; name: string }
    agent: { id: string; index: number; label: string; prompt: string; opts: AgentOpts }
    /** Called as soon as the child session exists (UI drill-down, stop). */
    onSession?: (sessionID: string) => void
  }

  /** Agent type used when the script passes no `agentType`. */
  export const AGENT = WORKFLOW_SUBAGENT

  /** Session metadata key that marks a workflow agent's child session. */
  export const METADATA = "kilo.workflow"

  const ZERO: Tokens = { input: 0, output: 0, reasoning: 0, total: 0 }

  /** Total structured-output attempts per agent (first prompt included). */
  export function attempts() {
    const value = Number(process.env.KILO_MAX_STRUCTURED_OUTPUT_RETRIES)
    return Number.isInteger(value) && value >= 1 ? value : 5
  }

  function text(value: unknown) {
    return typeof value === "string" && value.trim().length > 0
  }

  /**
   * Validate opts before any agent starts (unknown agentType, primary agent, unsatisfiable schema, …).
   * Returns an error message, or undefined when valid. Contract owned by the spawn unit.
   * Agent lookups need the agent registry, so an unknown or primary `agentType` surfaces from `make`
   * as a non-terminal error instead.
   */
  export function check(opts: AgentOpts): string | undefined {
    // label and phase end up in run summaries (RunInfo/AgentInfo/PhaseInfo), which only carry strings.
    if (opts.label !== undefined && typeof opts.label !== "string") return "opts.label must be a string"
    if (opts.phase !== undefined && typeof opts.phase !== "string") return "opts.phase must be a string"
    if (opts.agentType !== undefined && !text(opts.agentType)) return "opts.agentType must be a non-empty string"
    if (opts.model !== undefined && !text(opts.model)) return "opts.model must be a non-empty string"
    if (opts.effort !== undefined && typeof opts.effort !== "string") return "opts.effort must be a string"
    if (opts.isolation !== undefined && opts.isolation !== "worktree") return "opts.isolation must be 'worktree'"
    if (opts.schema !== undefined) return WorkflowSchema.check(opts.schema)
    return undefined
  }

  /** Sum of the session's step-finish token ledger, and its tool calls. */
  export const usage = Effect.fnUntraced(function* (sessions: Pick<Session.Interface, "messages">, id: SessionID) {
    const messages = yield* sessions.messages({ sessionID: id }).pipe(Effect.catch(() => Effect.succeed([])))
    const parts = messages.flatMap((message) => message.parts)
    const tokens = parts.reduce((sum, part) => {
      if (part.type !== "step-finish") return sum
      const step = part.tokens
      return {
        input: sum.input + step.input,
        output: sum.output + step.output,
        reasoning: sum.reasoning + step.reasoning,
        total:
          sum.total + (step.total ?? step.input + step.output + step.reasoning + step.cache.read + step.cache.write),
      }
    }, ZERO)
    return { tokens, tools: parts.filter((part) => part.type === "tool").length }
  })

  function result(message: SessionV1.WithParts) {
    return (
      message.parts
        .filter((part): part is MessageV2.TextPart => part.type === "text")
        .findLast((part) => !part.synthetic && !part.ignored && part.text.length > 0)?.text ?? ""
    )
  }

  /**
   * Run one workflow agent to completion in a child session of `parent.sessionID` and return its outcome.
   * Interrupting the returned effect cancels the child session and yields { status: "skipped" } semantics to the caller.
   * Contract owned by the spawn unit; `make` may require services — the run service provides them.
   */
  export const make = Effect.gen(function* () {
    const agents = yield* Agent.Service
    const sessions = yield* Session.Service
    const config = yield* Config.Service
    const provider = yield* Provider.Service
    const drain = yield* SessionDrain.Service
    const database = yield* Database.Service
    const store = yield* InstanceStore.Service
    const git = yield* Git.Service
    const worktrees = yield* Worktree.Service
    const project = yield* Project.Service

    const isolate = <A, E>(
      effect: Effect.Effect<A, E, Git.Service | Worktree.Service | Project.Service | InstanceStore.Service>,
    ) =>
      effect.pipe(
        Effect.provideService(Git.Service, git),
        Effect.provideService(Worktree.Service, worktrees),
        Effect.provideService(Project.Service, project),
        Effect.provideService(InstanceStore.Service, store),
      )

    /** Model (and variant) of the launching turn: its assistant message, else the session's model. */
    const origin = Effect.fnUntraced(function* (parent: Session.Info, messageID: MessageID) {
      const message = yield* MessageV2.get({ sessionID: parent.id, messageID }).pipe(
        Effect.provideService(Database.Service, database),
        Effect.catchCause(() => Effect.succeed(undefined)),
      )
      if (message?.info.role === "assistant") {
        return {
          model: { providerID: message.info.providerID, modelID: message.info.modelID },
          variant: message.info.variant,
        }
      }
      if (!parent.model) return undefined
      return {
        model: { providerID: parent.model.providerID, modelID: parent.model.id },
        variant: parent.model.variant === "default" ? undefined : parent.model.variant,
      }
    })

    return (input: Input): Effect.Effect<Outcome> => {
      const opts = input.agent.opts
      const name = opts.agentType ?? AGENT
      const parentID = SessionID.make(input.parent.sessionID)
      const held: { child?: SessionID } = {}

      const fail = (error: string, extra?: { warning?: string }): Outcome => ({
        status: "error",
        error,
        terminal: false,
        tokens: ZERO,
        tools: 0,
        ...extra,
      })

      const body = Effect.gen(function* () {
        const invalid = check(opts)
        if (invalid) return fail(invalid)
        const next = yield* agents.get(name)
        if (!next) return fail(`Unknown agent type: ${name} is not a valid agent type`)
        if (next.mode === "primary") return fail(`Agent "${name}" is a primary agent and cannot be used as a subagent`)
        // Fail closed like the Task tool: the launching agent's rules are the ceiling every agent inherits.
        const caller = yield* agents.get(input.parent.agent)
        if (!caller) return fail(`launching agent "${input.parent.agent}" is no longer available`)

        const cfg = yield* config.get()
        const parent = yield* sessions.get(parentID).pipe(Effect.orDie)
        // The Task tool asks `task` for every subagent type; a type the launching agent or session denies stays
        // denied here. Approving the workflow covers "ask". The default subagent is exempt: primaries deny it on
        // purpose so it is reachable only through workflows.
        if (
          name !== AGENT &&
          Permission.evaluate("task", name, caller.permission, parent.permission ?? []).action === "deny"
        ) {
          return fail(`Agent type "${name}" is denied by the launching agent's task permission`)
        }
        const source = yield* origin(parent, MessageID.make(input.parent.messageID))
        if (!source) return fail("cannot resolve the launching session's model")

        // Same precedence as the Task tool: explicit opts.model, then agent/config defaults, then the parent.
        const base = {
          name: next.name,
          agent: next,
          config: cfg,
          parent: source.model,
          variant: source.variant,
          provider,
        }
        const fallback = KiloTask.resolveModel(base).pipe(Effect.catch(() => Effect.succeed(source)))
        const selected = yield* KiloTask.resolveModel({ ...base, selection: { model: opts.model ?? null } }).pipe(
          Effect.map((value) => ({ value, warning: undefined as string | undefined })),
          Effect.catch((err) =>
            fallback.pipe(
              Effect.map((value) => ({
                value,
                warning: opts.model
                  ? `opts.model "${opts.model}" is unavailable (${errorMessage(err)}); used ${value.model.providerID}/${value.model.modelID} instead`
                  : undefined,
              })),
            ),
          ),
        )
        const model = selected.value.model
        const warning = selected.warning
        if (warning) log.warn("workflow agent model fallback", { run: input.run.id, agent: input.agent.id, warning })
        const full = yield* provider
          .getModel(model.providerID, model.modelID)
          .pipe(Effect.catch(() => Effect.succeed(undefined)))
        const keys = Object.keys(full?.variants ?? {})
        // An explicit effort maps onto this model's own variant keys (none fitting → provider default). Without
        // one the agent inherits the session effort, also when opts.model swaps the model (mapped onto its keys).
        const variant = WorkflowEffort.valid(opts.effort)
          ? WorkflowEffort.pick(opts.effort, keys)
          : opts.model && !warning && source.variant !== undefined
            ? keys.includes(source.variant)
              ? source.variant
              : WorkflowEffort.pick(source.variant, keys)
            : selected.value.variant

        const rules = KiloTask.inherited({ caller, session: parent, mcp: cfg.mcp })
        const permission = KiloTask.merge(
          deriveSubagentSessionPermission({ parentSessionPermission: parent.permission ?? [], subagent: next }),
          (cfg.experimental?.primary_tools ?? []).map((item) => ({
            permission: item,
            pattern: "*",
            action: "deny" as const,
          })),
          // Includes the deny for run files: scripts and journals are the launching session's own.
          KiloTask.permissions(rules, false),
        )

        const schema = opts.schema
        const structured = schema !== undefined
        const custom = name !== AGENT
        const instructions = custom
          ? structured
            ? WorkflowPrompts.NOTE_STRUCTURED
            : WorkflowPrompts.NOTE_TEXT
          : structured
            ? WorkflowPrompts.SUBAGENT_STRUCTURED
            : WorkflowPrompts.SUBAGENT_TEXT
        const tools = {
          question: false,
          task: false,
          workflow: false,
          ...(next.permission.some((rule) => rule.permission === "todowrite") ? {} : { todowrite: false }),
          ...Object.fromEntries((cfg.experimental?.primary_tools ?? []).map((item) => [item, false])),
          // Agents with a catch-all deny would otherwise lose the tool their answer depends on.
          ...(structured ? { [WorkflowPrompts.STRUCTURED_OUTPUT_TOOL]: true } : {}),
        }
        const sent = schema && full ? WorkflowSchema.portable(full, schema) : schema
        // Provider sanitising can retype values (Gemini turns numeric enums into string enums); the model can then
        // only answer in the sent shape, so validation coerces back to the script's original schema.
        const coerce = schema !== undefined && JSON.stringify(sent) !== JSON.stringify(schema)
        const format = sent ? { type: "json_schema" as const, schema: sent, retryCount: 0 } : undefined
        const ctx = yield* InstanceState.context

        const done = (value: unknown, sessionID: SessionID): Outcome => ({
          status: "completed",
          value,
          sessionID,
          tokens: ZERO,
          tools: 0,
          model: { providerID: model.providerID, modelID: model.modelID },
          ...(variant === undefined ? {} : { variant }),
          ...(warning ? { warning } : {}),
        })

        const skipped = (sessionID: SessionID): Outcome => ({
          status: "skipped",
          sessionID,
          tokens: ZERO,
          tools: 0,
          ...(warning ? { warning } : {}),
        })

        /** Error recorded on a finished child turn: a user stop skips the agent, anything else is terminal. */
        const failed = (error: NonNullable<SessionV1.Assistant["error"]>, sessionID: SessionID): Outcome =>
          error.name === "MessageAbortedError"
            ? skipped(sessionID)
            : {
                status: "error",
                error: errorMessage(error),
                terminal: true,
                sessionID,
                tokens: ZERO,
                tools: 0,
                ...(warning ? { warning } : {}),
              }

        // Runs in the agent's instance: the parent's, or its worktree's for isolation: 'worktree'.
        const agent = (handle?: WorkflowWorktree.Handle) =>
          Effect.gen(function* () {
            const platform = KiloSession.resolvePlatform(parentID)
            const child = yield* sessions.create({
              parentID,
              title: `${input.agent.label} (@${next.name} subagent)`,
              agent: next.name,
              platform,
              permission,
              metadata: {
                [METADATA]: {
                  runID: input.run.id,
                  agentID: input.agent.id,
                  index: input.agent.index,
                  label: input.agent.label,
                  ...(opts.phase === undefined ? {} : { phase: opts.phase }),
                },
              },
            })
            held.child = child.id
            KiloSession.register({ id: child.id, parentID, platform })
            yield* drain.link(child.id, parentID)
            yield* SandboxPolicy.inherit(
              parentID,
              child.id,
              SandboxPolicy.fallback(cfg),
              handle ? ctx.directory : undefined,
            ).pipe(Effect.provideService(Config.Service, config))
            input.onSession?.(child.id)

            const system = handle
              ? instructions + WorkflowPrompts.worktree({ path: handle.path, main: handle.main })
              : instructions

            /**
             * One prompt turn; returns the newest assistant message once the child's subtree drained, or undefined
             * when nothing answered this prompt (the session was stopped from outside before its first reply).
             */
            const turn = Effect.fnUntraced(function* (prompt: string) {
              const id = MessageID.ascending()
              const initial = yield* input.ops.prompt({
                messageID: id,
                sessionID: child.id,
                model: { providerID: model.providerID, modelID: model.modelID },
                variant,
                agent: next.name,
                system,
                tools,
                format,
                parts: [{ type: "text", text: prompt }],
              })
              yield* drain.wait(child.id)
              const latest = (yield* sessions.messages({ sessionID: child.id, limit: 1 }).pipe(Effect.orDie)).at(-1)
              const message = latest?.info.role === "assistant" && latest.info.id > initial.info.id ? latest : initial
              // Not a parentID check: a human steering the child can produce a newer reply with another parent.
              return message.info.role === "assistant" && message.info.id > id ? message : undefined
            })

            const plain = Effect.gen(function* () {
              const message = yield* turn(input.agent.prompt)
              if (!message) return skipped(child.id)
              if (message.info.role === "assistant" && message.info.error) return failed(message.info.error, child.id)
              return done(result(message), child.id)
            })

            const validated = Effect.gen(function* () {
              const limit = attempts()
              // Reassigned per attempt: the next prompt carries the previous attempt's validation error.
              let prompt = input.agent.prompt
              let last = ""
              for (const _ of Array.from({ length: limit })) {
                const message = yield* turn(prompt)
                if (!message) return skipped(child.id)
                const info = message.info
                if (info.role === "assistant" && info.error && info.error.name !== "StructuredOutputError") {
                  return failed(info.error, child.id)
                }
                const value = info.role === "assistant" ? info.structured : undefined
                const checked =
                  value === undefined
                    ? { error: `the ${WorkflowPrompts.STRUCTURED_OUTPUT_TOOL} tool was not called`, value }
                    : coerce
                      ? WorkflowSchema.coerce(schema ?? {}, value)
                      : { error: WorkflowSchema.validate(schema ?? {}, value), value }
                last = checked.error ?? ""
                if (value !== undefined && !last) return done(checked.value, child.id)
                prompt = WorkflowPrompts.retry(last)
              }
              return {
                ...fail(`StructuredOutput failed validation after ${limit} attempts: ${last}`, { warning }),
                sessionID: child.id,
              } satisfies Outcome
            })

            return yield* (structured ? validated : plain).pipe(
              Effect.onInterrupt(() => input.ops.cancel(child.id)),
              Effect.ensuring(KiloTaskBackgroundProcess.finish(child.id)),
            )
          })

        if (opts.isolation !== "worktree") return yield* agent()

        const branch = `kilo/wf/${input.run.id}-${input.agent.index}`
        // Acquired atomically, so a worktree that exists is always inspected (and removed if unchanged).
        return yield* Effect.acquireUseRelease(
          isolate(WorkflowWorktree.create(`${input.run.id}-${input.agent.index}`)).pipe(
            Effect.interruptible,
            Effect.result,
          ),
          (made) => {
            if (Result.isFailure(made)) return Effect.succeed(fail(made.failure, { warning }))
            const handle = made.success
            return store.provide({ directory: handle.path }, agent(handle)).pipe(
              Effect.flatMap((outcome) =>
                isolate(WorkflowWorktree.finish(handle, branch)).pipe(
                  Effect.uninterruptible,
                  Effect.map((worktree): Outcome => ({ ...outcome, worktree })),
                ),
              ),
            )
          },
          (made, exit) =>
            Result.isSuccess(made) && !Exit.isSuccess(exit)
              ? isolate(WorkflowWorktree.finish(made.success, branch)).pipe(Effect.ignore)
              : Effect.void,
        )
      })

      /** Fold the child's token ledger into the outcome and bill its cost to the launching message. */
      const settle = (outcome: Outcome) =>
        Effect.gen(function* () {
          if (!held.child) return outcome
          const spent = yield* usage(sessions, held.child)
          return { ...outcome, sessionID: outcome.sessionID ?? held.child, tokens: spent.tokens, tools: spent.tools }
        })

      const bill = Effect.suspend(() => {
        const child = held.child
        if (!child) return Effect.void
        return KiloCostPropagation.childCost(sessions, child).pipe(
          Effect.flatMap((cost) =>
            KiloCostPropagation.propagate(sessions, parentID, MessageID.make(input.parent.messageID), cost),
          ),
          Effect.provideService(Database.Service, database),
          Effect.catchCause((cause) =>
            Effect.sync(() => log.error("failed to propagate workflow agent cost", { child, cause })),
          ),
        )
      })

      return body.pipe(
        Effect.catchCause((cause) => {
          if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt
          const error = errorMessage(Cause.squash(cause))
          log.error("workflow agent failed", { run: input.run.id, agent: input.agent.id, error })
          return Effect.succeed<Outcome>({
            status: "error",
            error,
            terminal: true,
            ...(held.child ? { sessionID: held.child } : {}),
            tokens: ZERO,
            tools: 0,
          })
        }),
        Effect.flatMap(settle),
        Effect.ensuring(bill),
      )
    }
  })
}
