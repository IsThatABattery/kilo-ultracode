// Runtime tests drive the real sandbox worker with an injected spawn function, so every script hook, the
// journal, caps and lifecycle controls run for real without a model.

import { describe, expect, test } from "bun:test"
import path from "path"
import { Deferred, Effect, Fiber } from "effect"
import { WorkflowJournal } from "../../../src/kilocode/workflow/journal"
import { WorkflowMeta } from "../../../src/kilocode/workflow/meta"
import { WorkflowRuntime } from "../../../src/kilocode/workflow/runtime"
import { WorkflowSandbox } from "../../../src/kilocode/workflow/sandbox"
import type { Outcome, Ref, RunDetail, RunInfo, Tokens } from "../../../src/kilocode/workflow/types"
import type { TaskPromptOps } from "../../../src/tool/task"
import { tmpdir } from "../../fixture/fixture"

const TOKENS = { input: 5, output: 10, reasoning: 0, total: 15 }

const ok = (value: unknown, tokens = TOKENS): Outcome => ({
  status: "completed",
  value,
  sessionID: "ses_child",
  tokens,
  tools: 1,
  model: { providerID: "test", modelID: "model" },
})

const ops = {
  cancel: () => Effect.void,
  resolvePromptParts: () => Effect.succeed([]),
  prompt: () => Effect.die(new Error("the runtime never prompts directly")),
} as unknown as TaskPromptOps

type Spawn = WorkflowRuntime.Deps["spawn"]

function launch(input: {
  dir: string
  script: string
  spawn: Spawn
  id?: string
  args?: unknown
  total?: number | null
  journal?: ReadonlyArray<WorkflowJournal.Entry>
  concurrency?: number
  stagger?: number
  resolve?: (ref: Ref) => Effect.Effect<{ script: string; path: string }, Error>
  warm?: (sessionID: string) => Effect.Effect<void>
  usage?: (sessionID: string) => Effect.Effect<{ tokens: Tokens; tools: number }>
  main?: () => Effect.Effect<number>
}) {
  const id = input.id ?? WorkflowRuntime.id()
  const published: RunInfo[] = []
  const notes: string[] = []
  const orphans: string[] = []
  const holds = { active: 0, total: 0 }
  const pool = { main: 0, agents: 0 }
  const run = WorkflowRuntime.make(
    {
      spawn: input.spawn,
      sandbox: WorkflowSandbox.start,
      resolve: input.resolve ?? ((ref) => Effect.fail(new Error(`unknown workflow ${JSON.stringify(ref)}`))),
      warm: input.warm ?? (() => Effect.never),
      publish: (info) => Effect.sync(() => void published.push(info)),
      notify: (text) => Effect.sync(() => void notes.push(text)),
      orphan: (text) => Effect.sync(() => void orphans.push(text)),
      usage:
        input.usage ?? (() => Effect.succeed({ tokens: { input: 0, output: 0, reasoning: 0, total: 0 }, tools: 0 })),
      main: input.main ?? (() => Effect.succeed(0)),
      hold: () =>
        Effect.sync(() => {
          holds.active += 1
          holds.total += 1
          return () => {
            holds.active -= 1
          }
        }),
    },
    {
      id,
      dir: path.join(input.dir, id),
      parent: { sessionID: "ses_parent", messageID: "msg_parent", agent: "code" },
      ops,
      script: input.script,
      parsed: WorkflowMeta.parse(input.script),
      args: input.args,
      total: input.total ?? null,
      pool,
      size: "medium",
      ...(input.journal ? { journal: input.journal } : {}),
      concurrency: input.concurrency ?? 4,
      stagger: input.stagger ?? 0,
    },
  )
  const fiber = Effect.runFork(run.run)
  return {
    run,
    published,
    notes,
    orphans,
    holds,
    pool,
    finished: () => Effect.runPromise(Fiber.join(fiber)),
    /** What disposing the owning instance does: interrupt the run fiber. */
    interrupt: () => Effect.runPromise(Fiber.interrupt(fiber)),
  }
}

/** Poll until `check` holds (the run makes progress on other fibers and the worker thread). */
async function until(check: () => boolean, label: string, ms = 10_000) {
  const deadline = performance.now() + ms
  while (!check()) {
    if (performance.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await Bun.sleep(10)
  }
}

const result = (detail: RunDetail) => JSON.parse(detail.result ?? "null")

const values = (entries?: ReadonlyArray<WorkflowJournal.Entry>) =>
  entries?.map((item) => (item.type === "result" ? item.value : `pending:${item.index}`))

const meta = (name: string, extra = "") =>
  `export const meta = { name: ${JSON.stringify(name)}, description: "Test ${name}"${extra} }\n`

describe("WorkflowRuntime", () => {
  test("runs a script to completion, persists its files and notifies the parent", async () => {
    await using tmp = await tmpdir()
    const prompts: string[] = []
    const script =
      `export const meta = { name: "demo", description: "Demo run", phases: [{ title: "Scan", detail: "look" }, { title: "Fix" }] }\n` +
      `phase("Scan")\n` +
      `log("starting")\n` +
      `const found = await parallel([() => agent("find a"), () => agent("find b", { label: "b-finder" })])\n` +
      `phase("Fix")\n` +
      `const fixed = await agent("fix it")\n` +
      `return { found, fixed, args }\n`
    const started = launch({
      dir: tmp.path,
      script,
      args: { target: "src" },
      spawn: (input) =>
        Effect.sync(() => {
          prompts.push(input.agent.prompt)
          return ok(`result:${input.agent.prompt}`)
        }),
    })
    await started.finished()
    const detail = started.run.detail()

    expect(detail.status).toBe("completed")
    expect(result(detail)).toEqual({
      found: ["result:find a", "result:find b"],
      fixed: "result:fix it",
      args: { target: "src" },
    })
    expect(prompts.toSorted()).toEqual(["find a", "find b", "fix it"])
    expect(detail.list.map((item) => item.label)).toEqual(["find a", "b-finder", "fix it"])
    expect(detail.list.map((item) => item.phase)).toEqual(["Scan", "Scan", "Fix"])
    expect(detail.phases).toEqual([
      { title: "Scan", detail: "look", total: 2, running: 0, done: 2, error: 0, skipped: 0 },
      { title: "Fix", total: 1, running: 0, done: 1, error: 0, skipped: 0 },
    ])
    expect(detail).toMatchObject({ agents: 3, done: 3, error: 0, tokens: 45, tools: 3, logs: ["starting"] })
    expect(detail.ended).toBeGreaterThanOrEqual(detail.started)

    const dir = started.run.dir
    expect(await Bun.file(path.join(dir, "script.js")).text()).toBe(script)
    const journal = (await Bun.file(path.join(dir, "journal.jsonl")).text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
    expect(journal).toHaveLength(3)
    expect(journal.find((item) => item.label === "fix it")).toMatchObject({
      type: "result",
      phase: "Fix",
      value: "result:fix it",
    })
    const output = await Bun.file(path.join(dir, "output.json")).json()
    expect(output).toEqual({
      summary: 'Dynamic workflow "Demo run" completed',
      agentCount: 3,
      logs: ["starting"],
      result: { found: ["result:find a", "result:find b"], fixed: "result:fix it", args: { target: "src" } },
    })
    const saved = await Bun.file(path.join(dir, "run.json")).json()
    expect(saved.status).toBe("completed")
    expect(saved.list.map((item: { sessionID?: string }) => item.sessionID)).toEqual([
      "ses_child",
      "ses_child",
      "ses_child",
    ])

    expect(started.published.at(0)?.status).toBe("running")
    expect(started.published.at(-1)?.status).toBe("completed")
    expect(started.holds).toEqual({ active: 0, total: 1 })

    expect(started.notes).toHaveLength(1)
    const note = started.notes[0]
    expect(note.split("\n").slice(0, 5)).toEqual([
      "<task-notification>",
      `<task-id>${started.run.id}</task-id>`,
      `<output-file>${path.join(dir, "output.json")}</output-file>`,
      "<status>completed</status>",
      '<summary>Dynamic workflow "Demo run" completed</summary>',
    ])
    expect(note).toContain(`<result>${detail.result}</result>`)
    expect(note).toContain(
      `<diagnostics>Per-agent results: ${path.join(dir, "journal.jsonl")} — one {"type":"result",...} line per completed agent with its full return value.\n`,
    )
    expect(note).toContain(
      `To re-run with edited post-processing: workflow({scriptPath: '${path.join(dir, "script.js")}', resumeFromRunId: '${started.run.id}'}) — agents whose (prompt, opts) are unchanged replay from cache.</diagnostics>`,
    )
    expect(note).toMatch(
      /<usage><agent_count>3<\/agent_count><agents_done>3<\/agents_done><agents_error>0<\/agents_error><agents_skipped>0<\/agents_skipped><agents_empty_result>0<\/agents_empty_result><subagent_tokens>45<\/subagent_tokens><tool_uses>3<\/tool_uses><duration_ms>\d+<\/duration_ms><\/usage>\n<\/task-notification>$/,
    )
  })

  test("terminal agent errors return null, other errors throw from agent()", async () => {
    await using tmp = await tmpdir()
    const started = launch({
      dir: tmp.path,
      script:
        meta("errors") +
        `const a = await agent("terminal")\n` +
        `const b = await agent("broken").catch((err) => "caught: " + err.message)\n` +
        `const c = await agent("empty")\n` +
        `return { a, b, c }\n`,
      spawn: (input) =>
        Effect.succeed<Outcome>(
          input.agent.prompt === "terminal"
            ? { status: "error", error: "provider down", terminal: true, tokens: TOKENS, tools: 0 }
            : input.agent.prompt === "broken"
              ? {
                  status: "error",
                  error: "StructuredOutput failed validation",
                  terminal: false,
                  tokens: TOKENS,
                  tools: 0,
                }
              : ok(""),
        ),
    })
    await started.finished()
    const detail = started.run.detail()
    expect(result(detail)).toEqual({ a: null, b: "caught: StructuredOutput failed validation", c: "" })
    expect(detail.list.map((item) => item.status)).toEqual(["error", "error", "completed"])
    expect(detail.list[0].error).toBe("provider down")
    expect(started.notes[0]).toContain("<agents_error>2</agents_error>")
    expect(started.notes[0]).toContain("<agents_empty_result>1</agents_empty_result>")
  })

  test("invalid agent options throw before any agent starts", async () => {
    await using tmp = await tmpdir()
    const calls = { count: 0 }
    const started = launch({
      dir: tmp.path,
      script:
        meta("invalid") +
        `const errors = []\n` +
        `for (const opts of [{ isolation: "nope" }, { schema: { type: "array" } }, { schema: { type: "object", properties: {}, required: ["x"] } }]) {\n` +
        `  await agent("x", opts).catch((err) => errors.push(err.message))\n` +
        `}\n` +
        `return errors\n`,
      spawn: () => Effect.sync(() => (calls.count++, ok("never"))),
    })
    await started.finished()
    const errors = result(started.run.detail())
    expect(errors).toHaveLength(3)
    expect(errors[0]).toContain("isolation")
    expect(calls.count).toBe(0)
    expect(started.run.info().agents).toBe(0)
  })

  test("caps concurrent agents per run", async () => {
    await using tmp = await tmpdir()
    const load = { active: 0, peak: 0 }
    const started = launch({
      dir: tmp.path,
      concurrency: 2,
      script: meta("cap") + `return await parallel(Array.from({ length: 6 }, (_, i) => () => agent("task " + i)))\n`,
      spawn: (input) =>
        Effect.gen(function* () {
          load.active += 1
          load.peak = Math.max(load.peak, load.active)
          yield* Effect.sleep(30)
          load.active -= 1
          return ok(input.agent.index)
        }),
    })
    await started.finished()
    expect(result(started.run.detail())).toEqual([0, 1, 2, 3, 4, 5])
    expect(load.peak).toBe(2)
  })

  test("stops the script at 1000 agents per run", async () => {
    await using tmp = await tmpdir()
    const started = launch({
      dir: tmp.path,
      script:
        meta("runaway") +
        `let n = 0\n` +
        `const err = await (async () => { while (true) { await agent("a" + n); n++ } })().catch((e) => e.message)\n` +
        `return { n, err }\n`,
      spawn: () => Effect.succeed(ok("x", { input: 0, output: 0, reasoning: 0, total: 0 })),
    })
    await started.finished()
    const value = result(started.run.detail())
    expect(value.n).toBe(WorkflowRuntime.MAX_AGENTS)
    expect(value.err).toContain("1000 agents")
  }, 60_000)

  test("budget.total is a hard ceiling and budget.spent() tracks agent output tokens", async () => {
    await using tmp = await tmpdir()
    const started = launch({
      dir: tmp.path,
      total: 100,
      script:
        meta("budget") +
        `const out = []\n` +
        `const before = budget.remaining()\n` +
        `const err = await (async () => { for (let i = 0; i < 5; i++) out.push(await agent("a" + i)) })().catch((e) => e.message)\n` +
        `return { out, err, before, total: budget.total, spent: budget.spent(), remaining: budget.remaining() }\n`,
      spawn: (input) => Effect.succeed(ok(input.agent.prompt, { input: 1, output: 50, reasoning: 10, total: 61 })),
    })
    await started.finished()
    const value = result(started.run.detail())
    expect(value.out).toEqual(["a0", "a1"])
    expect(value.err).toContain("Token budget exhausted")
    expect(value).toMatchObject({ before: 100, total: 100, spent: 120, remaining: 0 })
  })

  test("stop cancels running agents and notifies with status stopped", async () => {
    await using tmp = await tmpdir()
    const stats = { interrupted: 0 }
    const started = launch({
      dir: tmp.path,
      script: meta("stoppable") + `await parallel([() => agent("a"), () => agent("b")])\nreturn "unreachable"\n`,
      spawn: () => Effect.never.pipe(Effect.onInterrupt(() => Effect.sync(() => void stats.interrupted++))),
    })
    await until(() => started.run.info().running === 2, "two running agents")
    await Effect.runPromise(started.run.stop())
    await started.finished()
    const detail = started.run.detail()
    expect(stats.interrupted).toBe(2)
    expect(detail.status).toBe("stopped")
    expect(detail.skipped).toBe(2)
    expect(started.notes).toHaveLength(1)
    expect(started.notes[0]).toContain("<status>stopped</status>")
    expect(started.notes[0]).toContain('<summary>Dynamic workflow "Test stoppable" was stopped</summary>')
    expect(started.holds.active).toBe(0)
  })

  test("when its instance goes away the run is persisted as stopped and the model is told from outside it", async () => {
    await using tmp = await tmpdir()
    const started = launch({
      dir: tmp.path,
      script: meta("disposed") + `await agent("a")\nreturn "unreachable"\n`,
      spawn: () => Effect.never,
    })
    await until(() => started.run.info().running === 1, "a running agent")
    await started.interrupt()
    const last = started.published.at(-1)
    expect(last?.status).toBe("stopped")
    expect(last?.ended).toBeNumber()
    expect(last?.skipped).toBe(1)
    const persisted = await Bun.file(path.join(started.run.dir, "run.json")).json()
    expect(persisted).toMatchObject({ status: "stopped", skipped: 1, pid: process.pid })
    // Not through the dying instance's notify: through the hand-off, once.
    expect(started.notes).toEqual([])
    expect(started.orphans).toHaveLength(1)
    expect(started.orphans[0]).toContain("<status>stopped</status>")
    expect(started.orphans[0]).toContain(`<result>${WorkflowRuntime.RELOADED}</result>`)
    expect(started.holds.active).toBe(0)
    expect(started.run.settled()).toBe(true)
  })

  test("an instance going away after the final notification started sends no second one", async () => {
    await using tmp = await tmpdir()
    const id = WorkflowRuntime.id()
    const notes: string[] = []
    const orphans: string[] = []
    const run = WorkflowRuntime.make(
      {
        spawn: () => Effect.succeed(ok("x")),
        sandbox: WorkflowSandbox.start,
        resolve: () => Effect.fail(new Error("none")),
        warm: () => Effect.never,
        publish: () => Effect.void,
        // The completion notification starts a parent turn that is still running when the instance goes away.
        notify: (text) => Effect.sync(() => void notes.push(text)).pipe(Effect.andThen(Effect.never)),
        orphan: (text) => Effect.sync(() => void orphans.push(text)),
        usage: () => Effect.succeed({ tokens: TOKENS, tools: 0 }),
        main: () => Effect.succeed(0),
        hold: () => Effect.succeed(() => undefined),
      },
      {
        id,
        dir: path.join(tmp.path, id),
        parent: { sessionID: "ses_parent", messageID: "msg_parent", agent: "code" },
        ops,
        script: meta("late") + `return await agent("a")\n`,
        parsed: WorkflowMeta.parse(meta("late") + `return await agent("a")\n`),
        args: undefined,
        total: null,
        pool: { main: 0, agents: 0 },
        size: "medium",
        stagger: 0,
      },
    )
    const fiber = Effect.runFork(run.run)
    await until(() => notes.length === 1, "completion notification")
    await Effect.runPromise(Fiber.interrupt(fiber))
    expect(run.info().status).toBe("completed")
    expect(orphans).toEqual([])
  })

  test("pause lets running agents finish but starts no new ones until resume", async () => {
    await using tmp = await tmpdir()
    const gate = Deferred.makeUnsafe<void>()
    const started = launch({
      dir: tmp.path,
      script: meta("pausable") + `const a = await agent("first")\nconst b = await agent("second")\nreturn [a, b]\n`,
      spawn: (input) =>
        Effect.gen(function* () {
          if (input.agent.prompt === "first") yield* Deferred.await(gate)
          return ok(input.agent.prompt)
        }),
    })
    await until(() => started.run.info().running === 1, "first agent running")
    await Effect.runPromise(started.run.pause())
    expect(started.run.info().status).toBe("paused")
    await until(() => started.notes.length === 1, "paused notification")
    expect(started.notes[0]).toContain("<status>paused</status>")
    expect(started.notes[0]).toContain("was paused</summary>")
    expect(started.holds.active).toBe(0)

    Deferred.doneUnsafe(gate, Effect.void)
    await until(() => started.run.info().agents === 2, "second agent call")
    await Bun.sleep(100)
    expect(started.run.detail().list.map((item) => item.status)).toEqual(["completed", "queued"])

    await Effect.runPromise(started.run.resume())
    expect(started.holds.active).toBe(1)
    await started.finished()
    expect(result(started.run.detail())).toEqual(["first", "second"])
    expect(started.notes.at(-1)).toContain("<status>completed</status>")
    expect(started.holds.active).toBe(0)
  })

  test("stop then resume reruns only the agents that were still running", async () => {
    await using tmp = await tmpdir()
    const live: string[] = []
    const hang = { on: true }
    const spawn: Spawn = (input) =>
      Effect.gen(function* () {
        live.push(input.agent.prompt)
        if (hang.on && input.agent.prompt === "B") return yield* Effect.never
        return ok(`v:${input.agent.prompt}`)
      })
    const script = meta("fanout") + `return await parallel(["A", "B", "C", "D"].map((name) => () => agent(name)))\n`
    const first = launch({ dir: tmp.path, script, spawn })
    await until(() => first.run.info().done === 3 && first.run.info().running === 1, "A, C and D done, B running")
    await Effect.runPromise(first.run.stop())
    await first.finished()
    const journal = await Effect.runPromise(WorkflowJournal.load(path.join(first.run.dir, "journal.jsonl")))
    expect(values(journal)?.toSorted()).toEqual(["pending:1", "v:A", "v:C", "v:D"])

    live.length = 0
    hang.on = false
    const second = launch({ dir: tmp.path, id: first.run.id, script, journal, spawn })
    await second.finished()
    // Claude Code: "Stopping the whole run doesn't count any agent as failed": only B starts over.
    expect(live).toEqual(["B"])
    expect(second.run.info().cached).toBe(3)
    expect(result(second.run.detail())).toEqual(["v:A", "v:B", "v:C", "v:D"])
    const rewritten = await Effect.runPromise(WorkflowJournal.load(path.join(second.run.dir, "journal.jsonl")))
    expect(values(rewritten)?.toSorted()).toEqual(["v:A", "v:B", "v:C", "v:D"])
  })

  test("a resumed run stages its journal, so a hard kill midway keeps the previous one", async () => {
    await using tmp = await tmpdir()
    const spawn: Spawn = (input) =>
      input.agent.prompt === "two" ? Effect.never : Effect.succeed(ok(`v:${input.agent.prompt}`))
    const script = meta("staged") + `const a = await agent("one")\nconst b = await agent("two")\nreturn [a, b]\n`
    const base = [
      { type: "result" as const, index: 0, key: WorkflowJournal.key("one", {}), label: "one", value: "v:one" },
      { type: "result" as const, index: 1, key: WorkflowJournal.key("three", {}), label: "three", value: "v:three" },
    ]
    const id = WorkflowRuntime.id()
    const dir = path.join(tmp.path, id)
    await Bun.write(path.join(dir, "journal.jsonl"), base.map((item) => JSON.stringify(item) + "\n").join(""))
    const started = launch({ dir: tmp.path, id, script, journal: base, spawn })
    await until(() => started.run.info().running === 1, "the second agent running")
    // Mid-run (as after a SIGKILL): the journal still holds every previous result, the staged file this run's.
    expect(values(await Effect.runPromise(WorkflowJournal.load(path.join(dir, "journal.jsonl"))))).toEqual([
      "v:one",
      "v:three",
    ])
    await until(() => Bun.file(path.join(dir, WorkflowJournal.STAGED)).size > 0, "staged cache hit")
    expect(values(await Effect.runPromise(WorkflowJournal.load(path.join(dir, WorkflowJournal.STAGED))))).toEqual([
      "v:one",
    ])
    await Effect.runPromise(started.run.stop())
    await started.finished()
    expect(await Bun.file(path.join(dir, WorkflowJournal.STAGED)).exists()).toBe(false)
    expect(values(await Effect.runPromise(WorkflowJournal.load(path.join(dir, "journal.jsonl"))))).toEqual([
      "v:one",
      "pending:1",
      "v:three",
    ])
  })

  test("a stopped run is not settled until its agents exited", async () => {
    await using tmp = await tmpdir()
    const exit = Deferred.makeUnsafe<void>()
    const started = launch({
      dir: tmp.path,
      script: meta("slow-stop") + `return await agent("a")\n`,
      spawn: () => Effect.never.pipe(Effect.onInterrupt(() => Deferred.await(exit))),
    })
    await until(() => started.run.info().running === 1, "a running agent")
    expect(started.run.settled()).toBe(false)
    const stopping = Effect.runPromise(started.run.stop())
    await until(() => started.run.info().status === "stopped", "stopped status")
    expect(started.run.settled()).toBe(false)
    Deferred.doneUnsafe(exit, Effect.void)
    await stopping
    await started.finished()
    expect(started.run.settled()).toBe(true)
  })

  test("tokens of interrupted agents still count toward the run and budget.spent()", async () => {
    await using tmp = await tmpdir()
    const started = launch({
      dir: tmp.path,
      script: meta("interrupted") + `return await parallel([() => agent("slow"), () => agent("fast")])\n`,
      spawn: (input) =>
        input.agent.prompt === "slow"
          ? Effect.sync(() => input.onSession?.("ses_slow")).pipe(Effect.andThen(Effect.never))
          : Effect.succeed(ok("fast")),
      usage: (sessionID) =>
        Effect.succeed({
          tokens: sessionID === "ses_slow" ? { input: 1, output: 30, reasoning: 4, total: 40 } : TOKENS,
          tools: 2,
        }),
    })
    await until(
      () => started.run.detail().list.some((item) => item.label === "slow" && item.sessionID === "ses_slow"),
      "slow agent session",
    )
    await Effect.runPromise(started.run.skip("a0"))
    await started.finished()
    const detail = started.run.detail()
    expect(detail.list[0]).toMatchObject({ status: "skipped", tokens: 40, tools: 2 })
    expect(detail.tokens).toBe(55)
    expect(started.pool.agents).toBe(34 + 10)
  })

  test("budget.spent() picks up main-loop tokens spent after launch", async () => {
    await using tmp = await tmpdir()
    const gate = Deferred.makeUnsafe<void>()
    const main = { value: 0 }
    const started = launch({
      dir: tmp.path,
      total: 1000,
      script:
        meta("main") +
        `await agent("first")\n` +
        `const err = await agent("second").catch((e) => e.message)\n` +
        `return { err, spent: budget.spent() }\n`,
      main: () => Effect.sync(() => main.value),
      spawn: (input) =>
        input.agent.prompt === "first"
          ? Deferred.await(gate).pipe(Effect.as(ok("x", { input: 0, output: 0, reasoning: 0, total: 0 })))
          : Effect.succeed(ok("never")),
    })
    await until(() => started.run.info().running === 1, "first agent running")
    // The main loop keeps answering after launching the workflow.
    main.value = 1200
    await until(() => started.pool.main === 1200, "main-loop refresh", 10_000)
    Deferred.doneUnsafe(gate, Effect.void)
    await started.finished()
    const value = result(started.run.detail())
    expect(value.err).toContain("Token budget exhausted")
    expect(value.spent).toBe(1200)
  })

  test("agent() rejects non-string label and phase options before counting the agent", async () => {
    await using tmp = await tmpdir()
    const started = launch({
      dir: tmp.path,
      script:
        meta("types") +
        `const errors = []\n` +
        `for (const opts of [{ label: 5 }, { phase: 2 }]) await agent("x", opts).catch((e) => errors.push(e.message))\n` +
        `return errors\n`,
      spawn: () => Effect.succeed(ok("never")),
    })
    await started.finished()
    expect(result(started.run.detail())).toEqual(["opts.label must be a string", "opts.phase must be a string"])
    expect(started.run.info()).toMatchObject({ agents: 0, phases: [] })
  })

  test("stopping one agent hands the script null and skips the journal", async () => {
    await using tmp = await tmpdir()
    const started = launch({
      dir: tmp.path,
      script: meta("skip") + `return await parallel([() => agent("slow"), () => agent("fast")])\n`,
      spawn: (input) => (input.agent.prompt === "slow" ? Effect.never : Effect.succeed(ok("fast"))),
    })
    await until(
      () => started.run.detail().list.some((item) => item.label === "slow" && item.status === "running"),
      "slow agent",
    )
    expect(await Effect.runPromise(started.run.skip("a0"))).toBe(true)
    await started.finished()
    const detail = started.run.detail()
    expect(result(detail)).toEqual([null, "fast"])
    expect(detail.list[0].status).toBe("skipped")
    const journal = await Effect.runPromise(WorkflowJournal.load(path.join(started.run.dir, "journal.jsonl")))
    expect(values(journal)).toEqual(["fast"])
    expect(await Effect.runPromise(started.run.skip("a0"))).toBe(false)
  })

  test("resume replays the unchanged prefix from the journal and runs the rest live", async () => {
    await using tmp = await tmpdir()
    const live: string[] = []
    const spawn: Spawn = (input) =>
      Effect.sync(() => {
        live.push(input.agent.prompt)
        return ok(`v:${input.agent.prompt}`)
      })
    const body = (second: string) =>
      meta("resumable") +
      `const a = await agent("one", { label: "first" })\n` +
      `const b = await agent(${JSON.stringify(second)})\n` +
      `const c = await agent("three")\n` +
      `return [a, b, c]\n`
    const first = launch({ dir: tmp.path, script: body("two"), spawn })
    await first.finished()
    expect(live).toEqual(["one", "two", "three"])

    const journal = await Effect.runPromise(WorkflowJournal.load(path.join(first.run.dir, "journal.jsonl")))
    live.length = 0
    const second = launch({ dir: tmp.path, id: first.run.id, script: body("two (edited)"), journal, spawn })
    await second.finished()
    // "one" replays; the edited call misses, so "three" runs live even though it is cached.
    expect(live).toEqual(["two (edited)", "three"])
    const detail = second.run.detail()
    expect(result(detail)).toEqual(["v:one", "v:two (edited)", "v:three"])
    expect(detail.list.map((item) => item.status)).toEqual(["cached", "completed", "completed"])
    expect(detail.cached).toBe(1)
    const rewritten = await Effect.runPromise(WorkflowJournal.load(path.join(second.run.dir, "journal.jsonl")))
    // The replaced call's earlier result is kept as well, for a resume that reverts the edit.
    expect(values(rewritten)?.toSorted()).toEqual(["v:one", "v:three", "v:two", "v:two (edited)"])

    // Same script again: every call replays.
    live.length = 0
    const third = launch({ dir: tmp.path, id: first.run.id, script: body("two (edited)"), journal: rewritten, spawn })
    await third.finished()
    expect(live).toEqual([])
    expect(third.run.info().cached).toBe(3)
  })

  test("a resumed run that stops early keeps the cached results it never reached", async () => {
    await using tmp = await tmpdir()
    const live: string[] = []
    const spawn: Spawn = (input) =>
      input.agent.prompt === "two (edited)"
        ? Effect.never
        : Effect.sync(() => {
            live.push(input.agent.prompt)
            return ok(`v:${input.agent.prompt}`)
          })
    const body = (second: string) =>
      meta("keeps") +
      `const a = await agent("one")\n` +
      `const b = await agent(${JSON.stringify(second)})\n` +
      `const c = await agent("three")\n` +
      `return [a, b, c]\n`
    const file = (dir: string) => path.join(dir, "journal.jsonl")
    const first = launch({ dir: tmp.path, script: body("two"), spawn })
    await first.finished()
    const journal = await Effect.runPromise(WorkflowJournal.load(file(first.run.dir)))

    // "one" replays, the edited call never finishes and the user stops the run before "three".
    const second = launch({ dir: tmp.path, id: first.run.id, script: body("two (edited)"), journal, spawn })
    await until(() => second.run.info().running === 1, "the edited agent running")
    await Effect.runPromise(second.run.stop())
    await second.finished()
    const kept = await Effect.runPromise(WorkflowJournal.load(file(second.run.dir)))
    // The edited call was still running when the run stopped: it is pending, the original "two" is kept after it.
    expect(values(kept)).toEqual(["v:one", "pending:1", "v:two", "v:three"])
    expect(kept?.map((item) => item.index)).toEqual([0, 1, 2, 3])

    // The original script resumes entirely from cache.
    live.length = 0
    const third = launch({ dir: tmp.path, id: first.run.id, script: body("two"), journal: kept, spawn })
    await third.finished()
    expect(live).toEqual([])
    expect(third.run.info().cached).toBe(3)
    expect(result(third.run.detail())).toEqual(["v:one", "v:two", "v:three"])
  })

  test("workflow() runs a nested script under a ▸ group, one level deep", async () => {
    await using tmp = await tmpdir()
    const scripts: Record<string, string> = {
      child: meta("child") + `phase("Inner")\nreturn await agent("child " + args.x)\n`,
      outer: meta("outer") + `return await workflow("child", {}).catch((err) => err.message)\n`,
    }
    const started = launch({
      dir: tmp.path,
      script:
        meta("parent") +
        `const v = await workflow("child", { x: 1 })\n` +
        `const nested = await workflow("outer")\n` +
        `const missing = await workflow("nope").catch((err) => err.message)\n` +
        `return { v, nested, missing }\n`,
      resolve: (ref) =>
        typeof ref === "string" && scripts[ref]
          ? Effect.succeed({ script: scripts[ref], path: path.join(tmp.path, `${ref}.js`) })
          : Effect.fail(new Error(`Unknown workflow ${JSON.stringify(ref)}`)),
      spawn: (input) => Effect.succeed(ok(`r:${input.agent.prompt}`)),
    })
    await started.finished()
    const detail = started.run.detail()
    expect(result(detail)).toEqual({
      v: "r:child 1",
      nested: "Nesting is one level only: workflow() cannot be called from inside a nested workflow",
      missing: 'Unknown workflow "nope"',
    })
    expect(detail.list).toHaveLength(1)
    expect(detail.list[0]).toMatchObject({ group: "▸ child", phase: "Inner" })
    expect(detail.phases.find((item) => item.title === "▸ child")).toMatchObject({ total: 1, done: 1 })
    expect(detail.phases.some((item) => item.title === "Inner")).toBe(false)
  })

  test("a script error fails the run and reports the message", async () => {
    await using tmp = await tmpdir()
    const started = launch({
      dir: tmp.path,
      script: meta("broken") + `await agent("a")\nthrow new Error("script exploded")\n`,
      spawn: () => Effect.succeed(ok("a")),
    })
    await started.finished()
    const detail = started.run.detail()
    expect(detail.status).toBe("error")
    expect(detail.error_message).toContain("script exploded")
    expect(started.notes[0]).toContain("<status>error</status>")
    expect(started.notes[0]).toContain('<summary>Dynamic workflow "Test broken" failed</summary>')
    expect(started.notes[0]).toMatch(/<result>[^<]*script exploded/)
  })

  test("prefix stagger holds same-shaped agents until the first one has output", async () => {
    await using tmp = await tmpdir()
    const warm = Deferred.makeUnsafe<void>()
    const release = Deferred.makeUnsafe<void>()
    const starts: string[] = []
    const started = launch({
      dir: tmp.path,
      stagger: 5_000,
      script:
        meta("stagger") +
        `return await parallel([() => agent("leader"), () => agent("follower"), () => agent("other", { agentType: "explore" })])\n`,
      warm: () => Deferred.await(warm),
      spawn: (input) =>
        Effect.gen(function* () {
          starts.push(input.agent.prompt)
          input.onSession?.(`ses_${input.agent.prompt}`)
          yield* Deferred.await(release)
          return ok(input.agent.prompt)
        }),
    })
    await until(() => starts.length === 2, "leader and differently shaped agent")
    await Bun.sleep(100)
    expect(starts.toSorted()).toEqual(["leader", "other"])
    Deferred.doneUnsafe(warm, Effect.void)
    await until(() => starts.length === 3, "follower after the leader warmed the cache")
    Deferred.doneUnsafe(release, Effect.void)
    await started.finished()
    expect(result(started.run.detail())).toEqual(["leader", "follower", "other"])
  })

  test("prefix stagger gives up after the timeout", async () => {
    await using tmp = await tmpdir()
    const starts: number[] = []
    const begin = performance.now()
    const started = launch({
      dir: tmp.path,
      stagger: 150,
      script: meta("timeout") + `return await parallel([() => agent("a"), () => agent("b")])\n`,
      spawn: (input) =>
        Effect.gen(function* () {
          starts.push(performance.now() - begin)
          input.onSession?.("ses_a")
          yield* Effect.sleep(400)
          return ok(input.agent.prompt)
        }),
    })
    await started.finished()
    expect(starts).toHaveLength(2)
    expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(140)
    expect(starts[1] - starts[0]).toBeLessThan(400)
  })
})

describe("WorkflowRuntime.notification", () => {
  test("truncates long results and points at output.json", () => {
    const long = "x".repeat(WorkflowRuntime.RESULT_LIMIT + 25)
    const detail: RunDetail = {
      id: "wf_00000000-000",
      sessionID: "ses_parent",
      name: "big",
      description: "Big result",
      status: "completed",
      phases: [],
      agents: 0,
      running: 0,
      done: 0,
      error: 0,
      skipped: 0,
      cached: 0,
      tokens: 0,
      tools: 0,
      size: "medium",
      started: 1000,
      ended: 1500,
      dir: "/data/workflow/ses_parent/wf_00000000-000",
      script: "/data/workflow/ses_parent/wf_00000000-000/script.js",
      logs: [],
      list: [],
      result: long,
    }
    const text = WorkflowRuntime.notification(detail, { empty: 0, now: 2000 })
    expect(text).toContain(
      `<result>${"x".repeat(WorkflowRuntime.RESULT_LIMIT)}... (truncated 25 chars, full result in /data/workflow/ses_parent/wf_00000000-000/output.json)</result>`,
    )
    expect(text).toContain("<duration_ms>500</duration_ms>")
  })

  test("run ids follow wf_<8 hex>-<3 hex>", () => {
    expect(WorkflowRuntime.id()).toMatch(/^wf_[0-9a-f]{8}-[0-9a-f]{3}$/)
  })
})
