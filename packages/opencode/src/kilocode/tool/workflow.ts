// The `workflow` tool (Claude Code's Workflow tool): launch a deterministic multi-agent script in the background.

import path from "path"
import { Effect, Option, Schema } from "effect"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import { assertExternalDirectoryEffect } from "@/tool/external-directory"
import type { TaskPromptOps } from "@/tool/task"
import { Tool } from "@/tool/tool"
import { WorkflowBudget } from "@/kilocode/workflow/budget"
import { KiloWorkflowEnabled } from "@/kilocode/workflow/enabled"
import { WorkflowMeta } from "@/kilocode/workflow/meta"
import { WorkflowPrompts } from "@/kilocode/workflow/prompts"
import { WorkflowSaved } from "@/kilocode/workflow/saved"
import { KiloWorkflow } from "@/kilocode/workflow/service"
import type { Phase } from "@/kilocode/workflow/types"
import DESCRIPTION from "./workflow.txt"

const IGNORED = "Ignored — set the workflow description in the script's `meta` block."

export const Params = Schema.Struct({
  script: Schema.optional(Schema.String).annotate({
    description:
      "Self-contained workflow script. Must begin with `export const meta = { name, description, phases }` (pure literal, no computed values) followed by the script body using agent()/parallel()/pipeline()/phase().",
  }),
  scriptPath: Schema.optional(Schema.String).annotate({
    description:
      "Path to a workflow script file on disk. Every workflow invocation persists its script under the session directory and returns the path in the tool result. To iterate, edit that file with the edit/write tools and re-invoke the workflow tool with the same `scriptPath` instead of re-sending the full script. Takes precedence over `script` and `name`.",
  }),
  name: Schema.optional(Schema.String).annotate({
    description: "Name of a saved workflow (from .kilo/workflows/). Resolves to a self-contained script.",
  }),
  args: Schema.optional(Schema.Unknown).annotate({
    description:
      "Optional input value exposed to the script as the global `args`, verbatim. Pass arrays/objects as actual JSON values, NOT as a JSON-encoded string — a stringified list breaks `args.filter`/`args.map` in the script. Use for parameterized named workflows (e.g. a research question).",
  }),
  resumeFromRunId: Schema.optional(Schema.String).annotate({
    description:
      "Run ID of a prior workflow invocation to resume from. Completed agent() calls with unchanged (prompt, opts) return their cached results instantly; only edited or new calls re-run. Same-session only. Stop the prior run first (from /workflows) before resuming.",
  }),
  description: Schema.optional(Schema.String).annotate({ description: IGNORED }),
  title: Schema.optional(Schema.String).annotate({ description: IGNORED }),
})
export type Params = Schema.Schema.Type<typeof Params>

export type Meta = {
  runID?: string
  name?: string
  description?: string
  phases?: Phase[]
  dir?: string
  script?: string
  truncated?: boolean
}

/** Tool description: the Claude Code text plus this configuration's size guideline. */
export function describe(cfg: Parameters<typeof KiloWorkflowEnabled.size>[0]) {
  const size = WorkflowPrompts.size(KiloWorkflowEnabled.size(cfg))
  return size ? `${DESCRIPTION.trimEnd()}\n\n${size}` : DESCRIPTION.trimEnd()
}

/** What the model reads right after launching: where the run lives and how to iterate on or resume it. */
export function launched(input: { runID: string; description: string; dir: string }) {
  const script = path.join(input.dir, "script.js")
  return [
    `Workflow launched in background. Run ID: ${input.runID}`,
    `Summary: ${input.description}`,
    `Transcript dir: ${input.dir}`,
    `Script file: ${script}`,
    `(Edit this file with the edit/write tools and re-invoke the workflow tool with {scriptPath: "${script}"} to iterate without resending the script.)`,
    `To resume after editing the script: workflow({scriptPath: "${script}", resumeFromRunId: "${input.runID}"}) — completed agents return cached results (cached results may themselves be empty — inspect journal.jsonl before assuming there is something to recover).`,
    "",
    "You will be notified when it completes. Use /workflows to watch live progress.",
  ].join("\n")
}

function ops(extra: Tool.Context["extra"]) {
  const value = extra?.promptOps
  if (!value || typeof value !== "object") return undefined
  const item = value as Partial<TaskPromptOps>
  if (typeof item.prompt !== "function" || typeof item.cancel !== "function") return undefined
  return value as TaskPromptOps
}

const fail = (message: string) => Effect.fail(new Error(message))

export const WorkflowTool = Tool.define<typeof Params, Meta, Config.Service, "workflow">(
  "workflow",
  Effect.gen(function* () {
    const config = yield* Config.Service

    /** The script to run: scriptPath first, then an inline script, then a saved workflow by name. */
    const source = (params: Params, ctx: Tool.Context) =>
      Effect.gen(function* () {
        const inst = yield* InstanceState.context
        if (params.scriptPath) {
          const file = path.resolve(inst.directory, params.scriptPath)
          yield* assertExternalDirectoryEffect(ctx, file, { bypass: KiloWorkflow.owned(file) })
          const text = yield* Effect.tryPromise(() => Bun.file(file).text()).pipe(
            Effect.catch(() => fail(`Cannot read workflow script: ${file}`)),
          )
          return { script: text, path: file }
        }
        if (params.script) return { script: params.script, path: undefined }
        if (params.name) {
          const directories = yield* config.directories()
          const found = yield* Effect.promise(() =>
            WorkflowSaved.find({ directories, directory: inst.directory, name: params.name ?? "" }),
          )
          if (!found) {
            const names = (yield* Effect.promise(() =>
              WorkflowSaved.list({ directories, directory: inst.directory }),
            )).map((item) => item.name)
            return yield* fail(
              `Unknown saved workflow "${params.name}".${names.length ? ` Saved workflows: ${names.join(", ")}` : " No saved workflows were found in .kilo/workflows/."}`,
            )
          }
          const text = yield* Effect.tryPromise(() => Bun.file(found.path).text()).pipe(
            Effect.catch(() => fail(`Cannot read saved workflow: ${found.path}`)),
          )
          return { script: text, path: found.path }
        }
        return yield* fail("Provide a workflow `script`, a `scriptPath`, or the `name` of a saved workflow.")
      })

    return () =>
      Effect.gen(function* () {
        const cfg = yield* config.get()
        return {
          description: describe(cfg),
          parameters: Params,
          execute: (params: Params, ctx: Tool.Context) =>
            Effect.gen(function* () {
              // Resolved from the running fiber: the service is part of the app runtime and the HTTP server graph,
              // not of the tool registry graph (it depends on worktree/instance services the registry must not pull in).
              const service = Option.getOrUndefined(yield* Effect.serviceOption(KiloWorkflow.Service))
              if (!service) return yield* fail("Dynamic workflows are unavailable in this runtime.")
              const prompt = ops(ctx.extra)
              if (!prompt) return yield* fail("The workflow tool can only run inside a session turn.")

              const found = yield* source(params, ctx)
              const parsed = yield* Effect.try({
                try: () => WorkflowMeta.parse(found.script),
                catch: (err) => new Error(err instanceof Error ? err.message : String(err)),
              })
              const meta = parsed.meta
              yield* ctx.ask({
                permission: "workflow",
                patterns: [meta.name],
                always: [meta.name],
                metadata: {
                  name: meta.name,
                  description: meta.description,
                  phases: meta.phases,
                  ...(found.path ? { script: found.path } : {}),
                },
              })

              const budget = WorkflowBudget.from(ctx.messages)
              const run = yield* service
                .launch({
                  sessionID: ctx.sessionID,
                  messageID: ctx.messageID,
                  agent: ctx.agent,
                  ops: prompt,
                  script: found.script,
                  args: params.args,
                  total: budget.total,
                  main: budget.main,
                  ...(budget.turn ? { turn: budget.turn } : {}),
                  ...(params.resumeFromRunId ? { resume: params.resumeFromRunId } : {}),
                })
                .pipe(Effect.mapError((err) => new Error(err.message)))

              return {
                title: meta.description,
                output: launched({ runID: run.info.id, description: meta.description, dir: run.dir }),
                metadata: {
                  runID: run.info.id,
                  name: meta.name,
                  description: meta.description,
                  phases: meta.phases,
                  dir: run.dir,
                  script: run.script,
                  truncated: false,
                },
              }
            }).pipe(Effect.orDie),
        }
      })
  }),
)
