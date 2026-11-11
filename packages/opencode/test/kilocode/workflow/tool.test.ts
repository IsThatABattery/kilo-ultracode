import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Cause, Effect, Exit, Fiber } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { Agent } from "../../../src/agent/agent"
import { Config } from "../../../src/config/config"
import { RuntimeFlags } from "../../../src/effect/runtime-flags"
import { EventV2Bridge } from "../../../src/event-v2-bridge"
import { KiloToolRegistry } from "../../../src/kilocode/tool/registry"
import { WorkflowTool, describe as describeTool, launched, saved, scripted } from "../../../src/kilocode/tool/workflow"
import { SessionDrain } from "../../../src/kilocode/session/drain"
import { WorkflowBudget } from "../../../src/kilocode/workflow/budget"
import { WorkflowPrompts } from "../../../src/kilocode/workflow/prompts"
import { WorkflowRuntime } from "../../../src/kilocode/workflow/runtime"
import { KiloWorkflow } from "../../../src/kilocode/workflow/service"
import type { Outcome } from "../../../src/kilocode/workflow/types"
import type { PermissionV1 } from "@opencode-ai/core/v1/permission"
import type { SessionPrompt } from "../../../src/session/prompt"
import { InstanceStore } from "../../../src/project/instance-store"
import { MessageID, type SessionID } from "../../../src/session/schema"
import { Session } from "../../../src/session/session"
import type { TaskPromptOps } from "../../../src/tool/task"
import { ToolRegistry } from "../../../src/tool/registry"
import { Tool } from "../../../src/tool/tool"
import { Truncate } from "../../../src/tool/truncate"
import { disposeAllInstances, provideTmpdirInstance, tmpdir } from "../../fixture/fixture"
import { pollWithTimeout, testEffect } from "../../lib/effect"

afterEach(async () => {
  await disposeAllInstances()
})

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      Agent.node,
      CrossSpawnSpawner.node,
      EventV2Bridge.node,
      Config.node,
      Session.node,
      SessionProjector.node,
      SessionDrain.node,
      Truncate.node,
      Database.node,
    ]),
  ),
)

const ok = (value: unknown): Outcome => ({
  status: "completed",
  value,
  sessionID: "ses_child",
  tokens: { input: 1, output: 2, reasoning: 0, total: 3 },
  tools: 0,
  model: { providerID: "test", modelID: "model" },
})

const SCRIPT = `export const meta = { name: "demo", description: "Demo workflow", phases: [{ title: "Scan" }] }
phase("Scan")
const found = await agent("look around")
return { found, args, total: budget.total }
`

type Asked = Omit<PermissionV1.Request, "id" | "sessionID" | "tool">

function harness(
  sessionID: SessionID,
  extra: { promptOps?: TaskPromptOps } = {},
  messages: SessionV1.WithParts[] = [],
) {
  const asks: Asked[] = []
  const ctx: Tool.Context = {
    sessionID,
    messageID: MessageID.ascending(),
    agent: "code",
    abort: new AbortController().signal,
    callID: "call_workflow",
    extra: { ...extra },
    messages,
    metadata: () => Effect.void,
    ask: (input) => Effect.sync(() => void asks.push(input)),
  }
  return { ctx, asks }
}

function prompts() {
  const sent: SessionPrompt.PromptInput[] = []
  const ops = {
    cancel: () => Effect.void,
    resolvePromptParts: () => Effect.succeed([]),
    prompt: (input: SessionPrompt.PromptInput) =>
      Effect.sync(() => {
        sent.push(input)
        return {} as SessionV1.WithParts
      }),
  } satisfies TaskPromptOps
  return { sent, ops }
}

const failure = (exit: Exit.Exit<unknown, unknown>) => {
  if (Exit.isSuccess(exit)) throw new Error("expected the tool call to fail")
  const error = Cause.squash(exit.cause)
  return error instanceof Error ? error.message : String(error)
}

const setup = Effect.gen(function* () {
  const sessions = yield* Session.Service
  const parent = yield* sessions.create({ title: "workflow parent" })
  const service = yield* KiloWorkflow.make({ spawn: (input) => Effect.succeed(ok(`seen:${input.agent.prompt}`)) })
  const tool = yield* Tool.init(yield* WorkflowTool)
  const run = (params: Parameters<typeof tool.execute>[0], ctx: Tool.Context) =>
    tool.execute(params, ctx).pipe(Effect.provideService(KiloWorkflow.Service, service))
  return { parent, service, tool, run }
})

describe("workflow tool", () => {
  it.live("launches the run in the background and reports where it lives", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const env = yield* setup
        const ops = prompts()
        const call = harness(env.parent.id, { promptOps: ops.ops })
        const result = yield* env.run({ script: SCRIPT, args: { target: "src" }, description: "ignored" }, call.ctx)

        const runID = result.metadata.runID ?? ""
        expect(runID).toMatch(/^wf_[0-9a-f]{8}-[0-9a-f]{3}$/)
        const dir = KiloWorkflow.dir(env.parent.id, runID)
        expect(result.output).toBe(launched({ runID, description: "Demo workflow", dir }))
        expect(result.output.split("\n")).toEqual([
          `Workflow launched in background. Run ID: ${runID}`,
          "Summary: Demo workflow",
          `Transcript dir: ${dir}`,
          `Script file: ${dir}/script.js`,
          `(Edit this file with the edit/write tools and re-invoke the workflow tool with {scriptPath: "${dir}/script.js"} to iterate without resending the script.)`,
          `To resume after editing the script: workflow({scriptPath: "${dir}/script.js", resumeFromRunId: "${runID}"}) — completed agents return cached results (cached results may themselves be empty — inspect journal.jsonl before assuming there is something to recover).`,
          "",
          "You will be notified when it completes. Use /workflows to watch live progress.",
        ])
        expect(result.metadata).toEqual({
          runID,
          name: "demo",
          description: "Demo workflow",
          phases: [{ title: "Scan" }],
          dir,
          script: path.join(dir, "script.js"),
          truncated: false,
        })
        // A script the model wrote: never "always", and a pattern no saved workflow's approval or name rule matches.
        expect(call.asks).toEqual([
          {
            permission: "workflow",
            patterns: [scripted("demo")],
            always: [],
            metadata: { disableAlways: true, name: "demo", description: "Demo workflow", phases: [{ title: "Scan" }] },
          },
        ])

        yield* pollWithTimeout(
          Effect.sync(() => (ops.sent.length > 0 ? true : undefined)),
          "completion notification was never injected",
          "10 seconds",
        )
        const note = ops.sent[0]
        expect(note.sessionID).toBe(env.parent.id)
        expect(note.parts).toHaveLength(1)
        expect(note.parts[0]).toMatchObject({ type: "text", synthetic: true, metadata: { background: true } })
        const text = note.parts[0].type === "text" ? note.parts[0].text : ""
        expect(text).toContain(`<task-id>${runID}</task-id>`)
        expect(text).toContain("<status>completed</status>")

        const detail = yield* env.service.get(runID)
        expect(detail?.status).toBe("completed")
        expect(JSON.parse(detail?.result ?? "null")).toEqual({
          found: "seen:look around",
          args: { target: "src" },
          total: null,
        })
        expect((yield* env.service.list(env.parent.id)).map((item) => item.id)).toEqual([runID])
        expect(yield* env.service.list("ses_other")).toEqual([])
      }),
    ),
  )

  it.live("re-runs a persisted script by scriptPath and resumes from its journal", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const env = yield* setup
        const ops = prompts()
        const first = yield* env.run({ script: SCRIPT }, harness(env.parent.id, { promptOps: ops.ops }).ctx)
        const runID = first.metadata.runID ?? ""
        yield* pollWithTimeout(
          Effect.sync(() => (ops.sent.length > 0 ? true : undefined)),
          "first run",
          "10 seconds",
        )

        // Run dirs are pre-approved: no external_directory prompt for the persisted script.
        const call = harness(env.parent.id, { promptOps: ops.ops })
        const again = yield* env.run({ scriptPath: first.metadata.script, resumeFromRunId: runID }, call.ctx)
        expect(again.metadata.runID).toBe(runID)
        expect(call.asks.map((item) => item.permission)).toEqual(["workflow"])
        expect(call.asks[0]).toMatchObject({ patterns: [scripted("demo")], always: [] })
        expect(call.asks[0].metadata).toMatchObject({ script: first.metadata.script, disableAlways: true })
        yield* pollWithTimeout(
          Effect.sync(() => (ops.sent.length > 1 ? true : undefined)),
          "resumed run",
          "10 seconds",
        )
        const detail = yield* env.service.get(runID)
        expect(detail?.cached).toBe(1)
      }),
    ),
  )

  it.live("refuses to resume a run that is still active or has no journal", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const parent = yield* sessions.create({ title: "workflow parent" })
        const service = yield* KiloWorkflow.make({ spawn: () => Effect.never })
        const tool = yield* Tool.init(yield* WorkflowTool)
        const ops = prompts()
        const run = (params: Parameters<typeof tool.execute>[0]) =>
          tool
            .execute(params, harness(parent.id, { promptOps: ops.ops }).ctx)
            .pipe(Effect.provideService(KiloWorkflow.Service, service))
        const first = yield* run({ script: SCRIPT })
        const runID = first.metadata.runID ?? ""
        const busy = yield* run({ script: SCRIPT, resumeFromRunId: runID }).pipe(Effect.exit)
        expect(failure(busy)).toContain(`Workflow run ${runID} is still running`)

        const missing = yield* run({ script: SCRIPT, resumeFromRunId: "wf_deadbeef-000" }).pipe(Effect.exit)
        expect(failure(missing)).toContain("has nothing to resume")

        const stopped = yield* service.stop(runID)
        expect(stopped?.status).toBe("stopped")
        yield* pollWithTimeout(
          Effect.sync(() => (ops.sent.length > 0 ? true : undefined)),
          "stop notification",
          "10 seconds",
        )
      }),
    ),
  )

  it.live('offers a project-scoped "always" only for a saved workflow run by name', () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        // Written before anything loads the config, which discovers .kilo directories once per instance.
        const file = path.join(dir, ".kilo", "workflows", "demo.js")
        yield* Effect.promise(() => Bun.write(file, SCRIPT))
        const env = yield* setup
        const call = harness(env.parent.id, { promptOps: prompts().ops })
        yield* env.run({ name: "demo" }, call.ctx)
        const pattern = saved("demo", dir)
        expect(pattern).toBe(`demo@${dir}`)
        expect(call.asks).toEqual([
          {
            permission: "workflow",
            patterns: [pattern],
            always: [pattern],
            metadata: { name: "demo", description: "Demo workflow", phases: [{ title: "Scan" }], script: file },
          },
        ])
        expect(saved("a*b?", "/p")).toBe("a_b_@/p")
      }),
    ),
  )

  it.live("rejects a resumeFromRunId that is not a run id of this session", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const env = yield* setup
        const ops = prompts()
        const first = yield* env.run({ script: SCRIPT }, harness(env.parent.id, { promptOps: ops.ops }).ctx)
        yield* pollWithTimeout(
          Effect.sync(() => (ops.sent.length > 0 ? true : undefined)),
          "first run",
          "10 seconds",
        )
        // A real journal exists one session over; a traversing id must not reach it.
        const other = `../${env.parent.id}/${first.metadata.runID}`
        const sessions = yield* Session.Service
        const second = yield* sessions.create({ title: "other session" })
        for (const id of [other, "wf_../../x", "../../../../tmp"]) {
          const exit = yield* env
            .run({ script: SCRIPT, resumeFromRunId: id }, harness(second.id, { promptOps: ops.ops }).ctx)
            .pipe(Effect.exit)
          expect(failure(exit)).toContain("has nothing to resume")
        }
        expect(yield* env.service.list(second.id)).toEqual([])
      }),
    ),
  )

  it.live("a nested workflow() may only run scripts the session can already read", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const env = yield* setup
        const outside = yield* Effect.promise(() => tmpdir())
        const child = `export const meta = { name: "child", description: "Child" }\nreturn "child ran"\n`
        yield* Effect.promise(() => Bun.write(path.join(outside.path, "child.js"), child))
        yield* Effect.promise(() => Bun.write(path.join(dir, "child.js"), child))
        const script = `export const meta = { name: "nest", description: "Nest" }
const inside = await workflow({ scriptPath: "child.js" })
const escaped = await workflow({ scriptPath: ${JSON.stringify(path.join(outside.path, "child.js"))} }).catch((e) => e.message)
return { inside, escaped }
`
        const ops = prompts()
        const result = yield* env.run({ script }, harness(env.parent.id, { promptOps: ops.ops }).ctx)
        yield* pollWithTimeout(
          Effect.sync(() => (ops.sent.length > 0 ? true : undefined)),
          "nested run",
          "10 seconds",
        )
        const detail = yield* env.service.get(result.metadata.runID ?? "")
        const value = JSON.parse(detail?.result ?? "null")
        expect(value.inside).toBe("child ran")
        expect(value.escaped).toContain("is outside the project")
        yield* Effect.promise(() => outside[Symbol.asyncDispose]())
      }),
    ),
  )

  it.live("refuses to relaunch a stopped run until its agents exited", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const parent = yield* sessions.create({ title: "workflow parent" })
        const exit = Promise.withResolvers<void>()
        const service = yield* KiloWorkflow.make({
          spawn: () => Effect.never.pipe(Effect.onInterrupt(() => Effect.promise(() => exit.promise))),
        })
        const tool = yield* Tool.init(yield* WorkflowTool)
        const ops = prompts()
        const run = (params: Parameters<typeof tool.execute>[0]) =>
          tool
            .execute(params, harness(parent.id, { promptOps: ops.ops }).ctx)
            .pipe(Effect.provideService(KiloWorkflow.Service, service))
        const first = yield* run({ script: SCRIPT })
        const runID = first.metadata.runID ?? ""
        yield* pollWithTimeout(
          service.get(runID).pipe(Effect.map((detail) => (detail?.running === 1 ? true : undefined))),
          "agent running",
        )
        const stopping = yield* service.stop(runID).pipe(Effect.forkChild)
        yield* pollWithTimeout(
          service.get(runID).pipe(Effect.map((detail) => (detail?.status === "stopped" ? true : undefined))),
          "stopped status",
        )
        const early = yield* run({ script: SCRIPT, resumeFromRunId: runID }).pipe(Effect.exit)
        expect(failure(early)).toContain("is still stopping; its agents have not exited yet")
        exit.resolve()
        yield* Fiber.join(stopping)
        yield* pollWithTimeout(
          Effect.sync(() => (ops.sent.length > 0 ? true : undefined)),
          "stop notification",
          "10 seconds",
        )
        const again = yield* run({ script: SCRIPT, resumeFromRunId: runID })
        expect(again.metadata.runID).toBe(runID)
        yield* service.stop(runID)
      }),
    ),
  )

  it.live("control routes and save reach runs from other instances and persisted runs", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const env = yield* setup
        const ops = prompts()
        const first = yield* env.run({ script: SCRIPT }, harness(env.parent.id, { promptOps: ops.ops }).ctx)
        const runID = first.metadata.runID ?? ""
        yield* pollWithTimeout(
          Effect.sync(() => (ops.sent.length > 0 ? true : undefined)),
          "first run",
          "10 seconds",
        )
        // A run that is only on disk (restart, reload, retention limit) can still be saved from /workflows.
        const gone = "wf_0000beef-000"
        const dir = KiloWorkflow.dir(env.parent.id, gone)
        const detail = yield* env.service.get(runID)
        yield* Effect.promise(async () => {
          await Bun.write(path.join(dir, "run.json"), JSON.stringify({ ...detail, id: gone, dir: "/elsewhere" }))
          await Bun.write(path.join(dir, "script.js"), SCRIPT.replace('name: "demo"', 'name: "persisted-demo"'))
        })
        const file = yield* env.service.save(gone, { scope: "project" })
        expect(file).toEndWith(path.join(".kilo", "workflows", "persisted-demo.js"))
        expect(yield* env.service.save("wf_00000000-404", { scope: "project" })).toBeUndefined()

        // Stop from another directory's instance (an Agent Manager worktree session, say).
        const hold = Promise.withResolvers<void>()
        const slow = yield* KiloWorkflow.make({
          spawn: () => Effect.promise(() => hold.promise).pipe(Effect.as(ok("x"))),
        })
        const launchedRun = yield* slow.launch({
          sessionID: env.parent.id,
          messageID: MessageID.ascending(),
          agent: "code",
          ops: ops.ops,
          script: SCRIPT,
          args: undefined,
          total: null,
          main: 0,
        })
        const stopped = yield* provideTmpdirInstance(() => slow.stop(launchedRun.info.id))
        expect(stopped?.status).toBe("stopped")
        hold.resolve()
      }),
    ),
  )

  it.live("an instance disposed mid-run still tells the model, from a fresh instance", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const store = yield* InstanceStore.Service
        const parent = yield* sessions.create({ title: "workflow parent" })
        const service = yield* KiloWorkflow.make({ spawn: () => Effect.never })
        const tool = yield* Tool.init(yield* WorkflowTool)
        const ops = prompts()
        const result = yield* tool
          .execute({ script: SCRIPT }, harness(parent.id, { promptOps: ops.ops }).ctx)
          .pipe(Effect.provideService(KiloWorkflow.Service, service))
        const runID = result.metadata.runID ?? ""
        yield* pollWithTimeout(
          service.get(runID).pipe(Effect.map((detail) => (detail?.running === 1 ? true : undefined))),
          "agent running",
        )
        // What a settings change does: dispose the instance (and with it the run's scope).
        yield* store.disposeDirectory(dir)
        yield* pollWithTimeout(
          Effect.sync(() => (ops.sent.length > 0 ? true : undefined)),
          "stopped notification after the reload",
          "15 seconds",
        )
        const text = ops.sent[0].parts[0].type === "text" ? ops.sent[0].parts[0].text : ""
        expect(text).toContain("<status>stopped</status>")
        expect(text).toContain(WorkflowRuntime.RELOADED)
        expect(ops.sent[0].sessionID).toBe(parent.id)
      }),
    ),
  )

  it.live("agents use the session's goal-unbound prompt when it offers one; the notification does not", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const parent = yield* sessions.create({ title: "workflow parent" })
        const ops = prompts()
        const raw: TaskPromptOps["prompt"] = () => Effect.die(new Error("agents prompt through the fake spawn"))
        const seen: TaskPromptOps["prompt"][] = []
        const service = yield* KiloWorkflow.make({
          spawn: (input) => Effect.sync(() => (seen.push(input.ops.prompt), ok("x"))),
        })
        const tool = yield* Tool.init(yield* WorkflowTool)
        yield* tool
          .execute({ script: SCRIPT }, harness(parent.id, { promptOps: { ...ops.ops, raw } as TaskPromptOps }).ctx)
          .pipe(Effect.provideService(KiloWorkflow.Service, service))
        yield* pollWithTimeout(
          Effect.sync(() => (ops.sent.length > 0 ? true : undefined)),
          "completion notification",
          "10 seconds",
        )
        expect(seen).toEqual([raw])
        expect(ops.sent[0].sessionID).toBe(parent.id)
      }),
    ),
  )

  it.live("asks for external_directory before reading a script outside the project", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const env = yield* setup
        const outside = yield* Effect.promise(() => tmpdir())
        const file = path.join(outside.path, "flow.js")
        yield* Effect.promise(() => fs.writeFile(file, SCRIPT))
        const call = harness(env.parent.id, { promptOps: prompts().ops })
        yield* env.run({ scriptPath: file }, call.ctx)
        expect(call.asks.map((item) => item.permission)).toEqual(["external_directory", "workflow"])
        yield* Effect.promise(() => outside[Symbol.asyncDispose]())
      }),
    ),
  )

  it.live("reports invalid input as a tool error", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const env = yield* setup
        const ops = prompts().ops
        const ctx = harness(env.parent.id, { promptOps: ops }).ctx

        expect(failure(yield* env.run({}, ctx).pipe(Effect.exit))).toContain("Provide a workflow `script`")
        expect(failure(yield* env.run({ script: "const x = 1" }, ctx).pipe(Effect.exit))).toContain("export const meta")
        expect(failure(yield* env.run({ name: "nope" }, ctx).pipe(Effect.exit))).toContain(
          'Unknown saved workflow "nope"',
        )
        const bare = harness(env.parent.id).ctx
        expect(failure(yield* env.run({ script: SCRIPT }, bare).pipe(Effect.exit))).toContain("inside a session turn")
        const unavailable = yield* env.tool.execute({ script: SCRIPT }, ctx).pipe(Effect.exit)
        expect(failure(unavailable)).toContain("unavailable in this runtime")
      }),
    ),
  )

  it.live("passes the user's +Nk budget directive to the script", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const env = yield* setup
        const ops = prompts()
        const user = {
          info: { id: MessageID.ascending(), role: "user", sessionID: env.parent.id },
          parts: [{ type: "text", text: "audit everything +250k" }],
        } as unknown as SessionV1.WithParts
        const result = yield* env.run({ script: SCRIPT }, harness(env.parent.id, { promptOps: ops.ops }, [user]).ctx)
        yield* pollWithTimeout(
          Effect.sync(() => (ops.sent.length > 0 ? true : undefined)),
          "budget run",
          "10 seconds",
        )
        const detail = yield* env.service.get(result.metadata.runID ?? "")
        expect(JSON.parse(detail?.result ?? "null").total).toBe(250_000)
      }),
    ),
  )
})

describe("workflow tool description", () => {
  test("appends the size guideline unless unrestricted", () => {
    const base = describeTool({})
    expect(base).toContain("Execute a workflow script that orchestrates multiple subagents deterministically.")
    expect(base.endsWith(WorkflowPrompts.size({ size: "medium", explicit: false }))).toBe(true)
    expect(describeTool({ experimental: { workflow_size: "large" } })).toContain(
      "This session has the workflow size guideline: large — keep workflows under 50 agents.",
    )
    expect(describeTool({ experimental: { workflow_size: "unrestricted" } })).not.toContain("size guideline")
  })
})

describe("workflow budget directive", () => {
  test("parses +Nk / +N.Nm targets", () => {
    expect(WorkflowBudget.parse("find bugs +500k")).toBe(500_000)
    expect(WorkflowBudget.parse("+1.5m deep audit")).toBe(1_500_000)
    expect(WorkflowBudget.parse("go (+2M)")).toBe(2_000_000)
    expect(WorkflowBudget.parse("no budget here")).toBeNull()
    expect(WorkflowBudget.parse("a+500k")).toBeNull()
    expect(WorkflowBudget.parse("+500kb file")).toBeNull()
  })

  test("reads the latest human message and main-loop output since it", () => {
    const user = (text: string, synthetic = false) =>
      ({
        info: { id: `msg_${text}`, role: "user" },
        parts: [{ type: "text", text, synthetic }],
      }) as unknown as SessionV1.WithParts
    const assistant = (output: number, reasoning: number) =>
      ({
        info: { id: "msg_a", role: "assistant" },
        parts: [{ type: "step-finish", tokens: { input: 99, output, reasoning, cache: { read: 0, write: 0 } } }],
      }) as unknown as SessionV1.WithParts
    const budget = WorkflowBudget.from([
      user("old +900k"),
      assistant(1000, 0),
      user("now +300k"),
      assistant(10, 5),
      user("<task-notification>", true),
      assistant(20, 0),
    ])
    expect({ ...budget, turn: String(budget.turn) }).toEqual({ total: 300_000, main: 35, turn: "msg_now +300k" })
    expect(WorkflowBudget.from([])).toEqual({ total: null, main: 0 })
  })
})

describe("workflow tool registration", () => {
  const stub = (id: string) => ({ id }) as unknown as Tool.Def
  const tools = {
    recall: stub("recall"),
    managerModels: stub("managerModels"),
    memory: stub("memory"),
    save: stub("save"),
    manager: stub("manager"),
    process: stub("process"),
    chart: stub("chart"),
    image: stub("image"),
    notify: stub("notify"),
    send: stub("send_file"),
    linkPr: stub("link_pr"),
    workflow: stub("workflow"),
  }
  const ids = (cfg: Parameters<typeof KiloToolRegistry.extra>[1], disable?: boolean) =>
    KiloToolRegistry.extra(tools, cfg, {
      experimentalSharedAgentBoard: false,
      ...(disable === undefined ? {} : { disableWorkflows: disable }),
    }).map((item) => item.id)

  test("is on by default", () => {
    expect(ids({})).toContain("workflow")
    expect(ids({ experimental: { workflows: true } })).toContain("workflow")
  })

  test("is removed by experimental.workflows: false or KILO_DISABLE_WORKFLOWS", () => {
    expect(ids({ experimental: { workflows: false } })).not.toContain("workflow")
    expect(ids({}, true)).not.toContain("workflow")
  })
})

describe("workflow tool in the tool registry", () => {
  const registry = (flags: Partial<RuntimeFlags.Info>) =>
    testEffect(
      LayerNode.compile(LayerNode.group([ToolRegistry.node, Agent.node]), [
        [RuntimeFlags.node, RuntimeFlags.layer(flags)],
      ]),
    )
  const enabled = registry({})
  const disabled = registry({ disableWorkflows: true })
  const ids = Effect.gen(function* () {
    return yield* (yield* ToolRegistry.Service).ids()
  })

  enabled.instance("lists the workflow tool by default", () =>
    Effect.gen(function* () {
      expect(yield* ids).toContain("workflow")
    }),
  )

  enabled.instance(
    "hides it when experimental.workflows is false",
    () =>
      Effect.gen(function* () {
        expect(yield* ids).not.toContain("workflow")
      }),
    { config: { experimental: { workflows: false } } },
  )

  disabled.instance("hides it when KILO_DISABLE_WORKFLOWS is set", () =>
    Effect.gen(function* () {
      expect(yield* ids).not.toContain("workflow")
    }),
  )
})
