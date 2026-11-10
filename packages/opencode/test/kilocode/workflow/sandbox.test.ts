import { afterEach, describe, expect, test } from "bun:test"
import path from "path"
import { WorkflowMeta } from "../../../src/kilocode/workflow/meta"
import { WorkflowSandbox } from "../../../src/kilocode/workflow/sandbox"
import { WorkflowProtocol } from "../../../src/kilocode/workflow/sandbox/protocol"
import type { Call } from "../../../src/kilocode/workflow/types"
import { tmpdir } from "../../fixture/fixture"

const FILE = "/virtual/run/script.js"
const HEADER = `export const meta = { name: "test", description: "sandbox test" }\n`

const handles: WorkflowSandbox.Handle[] = []
afterEach(() => {
  for (const handle of handles.splice(0)) handle.terminate()
})

/** Run a script body (meta header added) through the real parser and a real sandbox worker. */
function start(body: string, input: Partial<WorkflowSandbox.Input> = {}) {
  const calls: Call[] = []
  const handler = input.onCall ?? (async () => null)
  const handle = WorkflowSandbox.start({
    args: undefined,
    total: null,
    file: FILE,
    ...input,
    body: WorkflowMeta.parse(HEADER + body).body,
    onCall: (call) => {
      calls.push(call)
      return handler(call)
    },
  })
  handles.push(handle)
  return { handle, calls }
}

const run = (body: string, input: Partial<WorkflowSandbox.Input> = {}) => start(body, input).handle.result

const value = async (body: string, input: Partial<WorkflowSandbox.Input> = {}) => {
  const result = await run(body, input)
  if (!result.ok) throw new Error(`script failed: ${result.error}`)
  return result.value
}

const failure = async (body: string, input: Partial<WorkflowSandbox.Input> = {}) => {
  const result = await run(body, input)
  if (result.ok) throw new Error(`script succeeded: ${JSON.stringify(result.value)}`)
  return result.error
}

/** Host handler that answers agent() with "r:<prompt>" after `ms`, recording start/end events. */
function echo(events: string[], delay: (prompt: string) => number = () => 30) {
  return async (call: Call) => {
    if (call.method !== "agent") return null
    events.push(`start:${call.prompt}`)
    await Bun.sleep(delay(call.prompt))
    events.push(`end:${call.prompt}`)
    return `r:${call.prompt}`
  }
}

describe("WorkflowSandbox results", () => {
  test("returns the script value", async () => {
    expect(await value(`const a = 1\nreturn { sum: a + 1, list: [1, "two", null], nested: { ok: true } }`)).toEqual({
      sum: 2,
      list: [1, "two", null],
      nested: { ok: true },
    })
  })

  test("returns undefined when the script returns nothing", async () => {
    expect(await run(`const a = 1`)).toEqual({ ok: true, value: undefined })
  })

  test("drops non-JSON members the way JSON.stringify does", async () => {
    expect(await value(`return { f: () => 1, u: undefined, d: new Date(0) }`)).toEqual({
      d: "1970-01-01T00:00:00.000Z",
    })
  })

  test("reports thrown errors with name, message and script location", async () => {
    const error = await failure(`const a = 1\n\n  throw new RangeError("boom")`)
    expect(error).toMatch(/^RangeError: boom \(at \/virtual\/run\/script\.js:4:\d+\)$/)
  })

  test("reports runtime TypeErrors at the right line", async () => {
    const error = await failure(`const a = null\nreturn a.missing`)
    expect(error).toContain("TypeError")
    expect(error).toContain(`${FILE}:3:`)
  })

  test("describes thrown non-errors", async () => {
    expect(await failure(`throw "plain"`)).toBe("plain")
    expect(await failure(`throw { code: 1 }`)).toBe('{"code":1}')
  })

  test.each([
    ["bigint", "return 10n", "not JSON-serializable (bigint)"],
    ["function", "return () => 1", "not JSON-serializable (function)"],
    ["cycle", "const a = []\na.push(a)\nreturn a", "not JSON-serializable: JSON.stringify cannot serialize cyclic"],
    [
      "deep nesting",
      "let o = {}\nconst root = o\nfor (let i = 0; i < 1e6; i++) { o.c = {}; o = o.c }\nreturn root",
      "not JSON-serializable: Maximum call stack size exceeded",
    ],
  ])("rejects a non-serializable result (%s)", async (_, body, text) => {
    expect(await failure(body)).toContain(text)
  })

  test("exposes args verbatim and undefined when absent", async () => {
    const args = { files: ["a.ts", "b.ts"], depth: 2, flag: null }
    expect(await value(`return { args, mapped: args.files.map((f) => f.toUpperCase()) }`, { args })).toEqual({
      args,
      mapped: ["A.TS", "B.TS"],
    })
    expect(await value(`return typeof args`)).toBe("undefined")
  })

  test("fails clearly when args cannot be serialized", async () => {
    const args: Record<string, unknown> = {}
    args.self = args
    expect(await failure(`return 1`, { args })).toContain("workflow args must be JSON-serializable")
  })

  test("keeps runs isolated from each other", async () => {
    const [a, b] = await Promise.all([
      value(`globalThis.shared = 1\nObject.prototype.polluted = true\nreturn typeof shared`),
      value(`return [typeof globalThis.shared, typeof ({}).polluted]`),
    ])
    expect(a).toBe("number")
    expect(b).toEqual(["undefined", "undefined"])
  })
})

describe("WorkflowSandbox agent()", () => {
  test("routes agent calls with filtered opts and the current phase", async () => {
    const started = start(
      `phase("Scan")
const a = await agent("first", { label: "one", schema: { type: "object", properties: {} }, timeout: 5, model: null })
const b = await agent("second", { phase: "Verify", effort: "low", isolation: "worktree", agentType: "explore" })
phase("Fix")
const c = await agent("third")
return [a, b, c]`,
      { onCall: async (call) => (call.method === "agent" ? `r:${call.prompt}` : null) },
    )
    expect(await started.handle.result).toEqual({ ok: true, value: ["r:first", "r:second", "r:third"] })
    expect(started.calls).toEqual([
      { method: "phase", title: "Scan" },
      {
        method: "agent",
        prompt: "first",
        opts: { label: "one", schema: { type: "object", properties: {} }, phase: "Scan" },
      },
      {
        method: "agent",
        prompt: "second",
        opts: { phase: "Verify", effort: "low", isolation: "worktree", agentType: "explore" },
      },
      { method: "phase", title: "Fix" },
      { method: "agent", prompt: "third", opts: { phase: "Fix" } },
    ])
  })

  test("delivers structured values and null", async () => {
    const replies: Record<string, unknown> = { obj: { findings: [{ file: "a.ts", line: 3 }] }, none: null }
    expect(
      await value(`return [await agent("obj"), await agent("none")]`, {
        onCall: async (call) => (call.method === "agent" ? replies[call.prompt] : null),
      }),
    ).toEqual([{ findings: [{ file: "a.ts", line: 3 }] }, null])
  })

  test("surfaces host rejections as catchable errors", async () => {
    expect(
      await value(`try { await agent("x") } catch (e) { return [e instanceof Error, e.message] }`, {
        onCall: async () => {
          throw new Error("StructuredOutput failed validation after 5 attempts: missing title")
        },
      }),
    ).toEqual([true, "StructuredOutput failed validation after 5 attempts: missing title"])
  })

  test("surfaces synchronous host throws and unserializable host values", async () => {
    expect(
      await value(`try { await agent("x") } catch (e) { return e.message }`, {
        onCall: () => {
          throw new Error("sync host failure")
        },
      }),
    ).toBe("sync host failure")
    expect(
      await value(`try { await agent("x") } catch (e) { return e.message }`, { onCall: async () => 10n }),
    ).toContain("agent() result is not JSON-serializable")
  })

  test("rejects invalid prompts and opts without calling the host", async () => {
    const started = start(`const out = []
for (const make of [() => agent(1), () => agent("x", "opts"), () => { const s = {}; s.s = s; return agent("x", { schema: s }) }]) {
  try { await make() } catch (e) { out.push(e.constructor.name + ": " + e.message) }
}
return out`)
    const result = await started.handle.result
    expect(result.ok && result.value).toEqual([
      "TypeError: agent() prompt must be a string",
      "TypeError: agent() opts must be an object",
      expect.stringContaining("TypeError: agent() opts must be JSON-serializable"),
    ])
    expect(started.calls).toEqual([])
  })

  test("keeps the bridge working when the script patches built-ins", async () => {
    expect(
      await value(
        `JSON.parse = () => "pwned"
JSON.stringify = () => "pwned"
Promise.prototype.then = function () { throw new Error("patched then") }
Reflect.apply = () => "pwned"
Object.freeze = (x) => x
const a = await agent("x")
const b = await parallel([() => agent("y")])
return a + "," + b.length`,
        { onCall: async (call) => (call.method === "agent" ? `r:${call.prompt}` : null) },
      ),
    ).toBe("r:x,1")
  })

  test("runs hundreds of concurrent calls", async () => {
    const result = await value(
      `const r = await parallel(Array.from({ length: 300 }, (_, i) => () => agent("p" + i)))\nreturn r.filter(Boolean).length`,
      {
        onCall: async (call) => (call.method === "agent" ? call.prompt : null),
      },
    )
    expect(result).toBe(300)
  })
})

describe("WorkflowSandbox parallel()", () => {
  test("runs async closures concurrently", async () => {
    const events: string[] = []
    const result = await value(
      `return parallel([1, 2, 3].map((i) => async () => {
  const a = await agent("a" + i)
  return await agent("b" + i + ":" + a)
}))`,
      { onCall: echo(events) },
    )
    expect(result).toEqual(["r:b1:r:a1", "r:b2:r:a2", "r:b3:r:a3"])
    // All first steps start before any of them finishes: the closures interleave instead of running serially.
    expect(events.slice(0, 3)).toEqual(["start:a1", "start:a2", "start:a3"])
  })

  test("resolves throwing thunks to null and never rejects", async () => {
    expect(
      await value(
        `return parallel([
  () => 1,
  () => { throw new Error("sync") },
  async () => { throw new Error("async") },
  () => agent("fails"),
  () => agent("works"),
  5,
  () => undefined,
])`,
        {
          onCall: async (call) => {
            if (call.method !== "agent") return null
            if (call.prompt === "fails") throw new Error("agent failed")
            return "ok"
          },
        },
      ),
    ).toEqual([1, null, null, null, "ok", 5, null])
  })

  test("accepts iterables and empty lists", async () => {
    expect(await value(`return [await parallel(new Set([() => 1, () => 2])), await parallel([])]`)).toEqual([
      [1, 2],
      [],
    ])
  })

  test("enforces the per-call item cap", async () => {
    expect(
      await value(`const ok = await parallel(Array.from({ length: ${WorkflowProtocol.LIMIT} }, (_, i) => () => i))
try { await parallel(Array.from({ length: ${WorkflowProtocol.LIMIT + 1} }, () => () => 1)) } catch (e) { return [ok.length, e.message] }`),
    ).toEqual([
      WorkflowProtocol.LIMIT,
      `parallel() accepts at most ${WorkflowProtocol.LIMIT} items per call (got ${WorkflowProtocol.LIMIT + 1}); split the work into smaller batches`,
    ])
  })

  test("rejects non-arrays", async () => {
    expect(await value(`try { await parallel(5) } catch (e) { return e.message }`)).toBe("parallel() expects an array")
  })
})

describe("WorkflowSandbox pipeline()", () => {
  test("passes (prev, item, index) to every stage", async () => {
    expect(
      await value(
        `return pipeline(["a", "b"], (prev, item, index) => prev + item + index, async (prev, item, index) => ({ prev, item, index }))`,
      ),
    ).toEqual([
      { prev: "aa0", item: "a", index: 0 },
      { prev: "bb1", item: "b", index: 1 },
    ])
  })

  test("drops a throwing item to null and skips its remaining stages", async () => {
    const started = start(
      `return pipeline([1, 2, 3, 4],
  (x) => { if (x === 2) throw new Error("sync stage"); return x },
  async (x) => { if (x === 3) throw new Error("async stage"); return x },
  (x) => x === 4 ? agent("fails") : x,
  (x) => { log("last " + x); return x * 10 })`,
      {
        onCall: async (call) => {
          if (call.method === "agent") throw new Error("agent failed")
          return null
        },
      },
    )
    expect(await started.handle.result).toEqual({ ok: true, value: [10, null, null, null] })
    expect(started.calls.filter((call) => call.method === "log")).toEqual([{ method: "log", message: "last 1" }])
  })

  test("has no barrier between stages", async () => {
    const events: string[] = []
    const result = await value(
      `return pipeline(["fast", "slow"], (item) => agent("one:" + item), (prev, item) => agent("two:" + item))`,
      { onCall: echo(events, (prompt) => (prompt === "one:slow" ? 300 : 10)) },
    )
    expect(result).toEqual(["r:two:fast", "r:two:slow"])
    // The fast item reaches stage two while the slow item is still in stage one.
    expect(events.indexOf("start:two:fast")).toBeLessThan(events.indexOf("end:one:slow"))
  })

  test("returns items unchanged with no stages and validates input", async () => {
    expect(
      await value(`const same = await pipeline([1, 2])
const errors = []
for (const make of [() => pipeline(1), () => pipeline([1], "x"), () => pipeline(Array.from({ length: ${WorkflowProtocol.LIMIT + 1} }), (x) => x)]) {
  try { await make() } catch (e) { errors.push(e.message) }
}
return { same, errors }`),
    ).toEqual({
      same: [1, 2],
      errors: [
        "pipeline() expects an array",
        "pipeline() stage 1 must be a function",
        `pipeline() accepts at most ${WorkflowProtocol.LIMIT} items per call (got ${WorkflowProtocol.LIMIT + 1}); split the work into smaller batches`,
      ],
    })
  })
})

describe("WorkflowSandbox hooks", () => {
  test("log() and console.* are fire-and-forget narrator lines", async () => {
    const started = start(`log("plain")
log("count", 3, { a: 1 })
console.log("from console")
const r = log("x")
return r === undefined`)
    expect(await started.handle.result).toEqual({ ok: true, value: true })
    expect(started.calls).toEqual([
      { method: "log", message: "plain" },
      { method: "log", message: 'count 3 {"a":1}' },
      { method: "log", message: "from console" },
      { method: "log", message: "x" },
    ])
  })

  test("phase() is synchronous and validates its title", async () => {
    expect(
      await value(`const r = phase("A")\ntry { phase(1) } catch (e) { return [r === undefined, e.message] }`),
    ).toEqual([true, "phase() title must be a string"])
  })

  test("workflow() forwards a name or scriptPath plus args", async () => {
    const started = start(
      `const a = await workflow("triage", { issue: 7 })
const b = await workflow({ scriptPath: "/tmp/child.js", extra: true })
let c
try { await workflow(42) } catch (e) { c = e.message }
return [a, b, c]`,
      { onCall: async (call) => (call.method === "workflow" ? { child: call.ref } : null) },
    )
    expect(await started.handle.result).toEqual({
      ok: true,
      value: [
        { child: "triage" },
        { child: { scriptPath: "/tmp/child.js" } },
        "workflow() expects a saved workflow name or { scriptPath }",
      ],
    })
    expect(started.calls).toEqual([
      { method: "workflow", ref: "triage", args: { issue: 7 } },
      { method: "workflow", ref: { scriptPath: "/tmp/child.js" } },
    ])
  })

  test("budget reads the token counter the host pushes", async () => {
    const started = start(
      `const before = [budget.total, budget.spent(), budget.remaining()]
await agent("x")
return { before, after: [budget.spent(), budget.remaining()], frozen: Object.isFrozen(budget) }`,
      {
        total: 1000,
        onCall: async () => {
          started.handle.spent(1200)
          return "done"
        },
      },
    )
    // Pushed before the worker is ready: delivered with the init payload.
    started.handle.spent(250)
    expect(await started.handle.result).toEqual({
      ok: true,
      value: { before: [1000, 250, 750], after: [1200, 0], frozen: true },
    })
  })

  test("budget.remaining() is Infinity without a target", async () => {
    expect(await value(`return [budget.total, budget.remaining() === Infinity]`)).toEqual([null, true])
  })
})

describe("WorkflowSandbox determinism", () => {
  test("Date.now(), argless new Date(), Date() and Math.random() throw", async () => {
    const result = await value(`const out = {}
for (const [key, make] of Object.entries({
  now: () => Date.now(),
  ctor: () => new Date(),
  call: () => Date(),
  random: () => Math.random(),
  sub: () => new (class extends Date {})(),
})) {
  try { make(); out[key] = "allowed" } catch (e) { out[key] = e.message }
}
return out`)
    expect(result).toEqual({
      now: "Date.now() is unavailable in workflow scripts — pass timestamps via args",
      ctor: "new Date() is unavailable in workflow scripts — pass timestamps via args",
      call: "Date() is unavailable in workflow scripts — pass timestamps via args",
      random: "Math.random() is unavailable in workflow scripts — vary the agent prompt/label by index instead",
      sub: "new Date() is unavailable in workflow scripts — pass timestamps via args",
    })
  })

  test("Date with explicit values still works", async () => {
    expect(
      await value(`const d = new Date(0)
return [d.toISOString(), d instanceof Date, d.constructor === Date, Date.UTC(2020, 0, 2), Date.parse("2020-01-02T00:00:00Z"), new Date("2021-05-06").getUTCFullYear(), new (class extends Date {})(5).getTime()]`),
    ).toEqual(["1970-01-01T00:00:00.000Z", true, true, 1577923200000, 1577923200000, 2021, 5])
  })

  test("Temporal.Now is unavailable when Temporal exists", async () => {
    const result = await value(`if (typeof Temporal === "undefined") return "absent"
try { Temporal.Now.instant(); return "allowed" } catch (e) { return e.message }`)
    expect([
      "absent",
      "Temporal.Now.instant() is unavailable in workflow scripts — pass timestamps via args",
    ]).toContain(result as string)
  })
})

describe("WorkflowSandbox confinement", () => {
  test("host globals are absent", async () => {
    expect(
      await value(
        `return ["process", "Bun", "require", "fetch", "setTimeout", "setInterval", "queueMicrotask", "performance", "Worker", "postMessage", "self", "WeakRef", "FinalizationRegistry"].map((k) => k + ":" + typeof globalThis[k])`,
      ),
    ).toEqual([
      "process:undefined",
      "Bun:undefined",
      "require:undefined",
      "fetch:undefined",
      "setTimeout:undefined",
      "setInterval:undefined",
      "queueMicrotask:undefined",
      "performance:undefined",
      "Worker:undefined",
      "postMessage:undefined",
      "self:undefined",
      "WeakRef:undefined",
      "FinalizationRegistry:undefined",
    ])
  })

  test("constructor-chain escapes from every exposed value are blocked", async () => {
    const result = await value(
      `const probe = (value) => {
  try { return typeof value.constructor.constructor("return typeof process")() } catch (e) { return "blocked:" + e.name }
}
let hostError
try { await agent("x") } catch (e) { hostError = e }
let codegen
try { (() => {}).constructor("return 1")() } catch (e) { codegen = e }
let overflow
// Not a tail call: JSC runs strict-mode tail calls in constant stack space.
const deep = () => 1 + deep()
try { deep() } catch (e) { overflow = e }
// Call into the bridge right at the stack limit: whatever log() throws there must be an in-context object.
const edge = []
const dive = () => { try { dive() } catch (e) { try { log("edge") } catch (inner) { edge.push(inner) } } }
dive()
const bridgeOverflow = edge[0] ?? overflow
return {
  agent: probe(agent), parallel: probe(parallel), pipeline: probe(pipeline), workflow: probe(workflow),
  phase: probe(phase), log: probe(log), console: probe(console.log), budget: probe(budget), spent: probe(budget.spent),
  args: probe(args), hostError: probe(hostError), codegen: probe(codegen), overflow: probe(overflow),
  bridgeOverflow: probe(bridgeOverflow), promise: probe(agent("y")), date: probe(Date), now: probe(Date.now),
  edge: edge.map(probe).filter((item) => item !== "blocked:EvalError").length === 0 ? "blocked:EvalError" : "leak",
}`,
      {
        args: { a: 1 },
        onCall: async (call) => {
          if (call.method === "agent" && call.prompt === "x") throw new Error("host failure")
          return null
        },
      },
    )
    const values = Object.values(result as Record<string, string>)
    expect(values.length).toBe(18)
    for (const item of values) expect(item).toBe("blocked:EvalError")
  })

  test("eval and Function constructors are disabled", async () => {
    expect(
      await value(`const out = []
for (const make of [() => eval("1"), () => Function("return 1")(), () => (async () => {}).constructor("return 1"), () => (function* () {}).constructor("yield 1")]) {
  try { make(); out.push("allowed") } catch (e) { out.push(e.name) }
}
return out`),
    ).toEqual(["EvalError", "EvalError", "EvalError", "EvalError"])
  })

  test("Error.prepareStackTrace cannot be installed to collect call sites", async () => {
    expect(
      await value(
        `try { Error.prepareStackTrace = (e, frames) => frames; return typeof new Error("x").stack } catch (e) { return e.name }`,
      ),
    ).toBe("TypeError")
    expect(
      await value(`Object.defineProperty(Error, "prepareStackTrace", { value: (e, f) => f })`).catch(() => "threw"),
    ).toBe("threw")
  })

  test("dynamic import is unavailable even when the parser is bypassed", async () => {
    const handle = WorkflowSandbox.start({
      body: `const fs = await import("node:fs")\nreturn typeof fs.readFileSync`,
      args: undefined,
      total: null,
      file: FILE,
      onCall: async () => null,
    })
    handles.push(handle)
    const result = await handle.result
    expect(result.ok).toBe(false)
  })

  test("un-awaited rejections do not crash the worker", async () => {
    expect(
      await value(
        `agent("rejects")
parallel(5)
pipeline(null)
Promise.reject(new Error("loose"))
;(async () => { throw new Error("loose async") })()
return await agent("ok")`,
        {
          onCall: async (call) => {
            if (call.method === "agent" && call.prompt === "rejects") throw new Error("nope")
            return "fine"
          },
        },
      ),
    ).toBe("fine")
  })
})

describe("WorkflowSandbox lifecycle", () => {
  test("terminate() stops a run waiting on the host", async () => {
    const pending = Promise.withResolvers<void>()
    const started = start(`return await agent("hang")`, {
      onCall: async () => {
        pending.resolve()
        return new Promise(() => undefined)
      },
    })
    await pending.promise
    started.handle.terminate()
    expect(await started.handle.result).toEqual({ ok: false, error: WorkflowSandbox.STOPPED })
  })

  test("terminate() wins over a later completion", async () => {
    const started = start(`return 1`)
    started.handle.terminate()
    expect(await started.handle.result).toEqual({ ok: false, error: "stopped" })
  })

  test.each([
    ["synchronous busy loop", `while (true) {}`],
    ["busy loop after an await", `await agent("x")\nwhile (true) {}`],
    ["endless microtask loop", `await agent("x")\nfor (;;) await null`],
  ])("the watchdog kills an unresponsive script (%s)", async (_, body) => {
    expect(await run(body, { watchdog: { interval: 20, timeout: 250 } })).toEqual({
      ok: false,
      error: WorkflowSandbox.UNRESPONSIVE,
    })
  })

  test("the watchdog leaves an idle script waiting on slow agents alone", async () => {
    expect(
      // The agent outlives the silence bound several times over; pongs keep the run alive. The bound still leaves
      // room for a cold worker boot (transpiling the worker on first use).
      await value(`return await agent("slow")`, {
        watchdog: { interval: 20, timeout: 600 },
        onCall: async () => {
          await Bun.sleep(2_000)
          return "late"
        },
      }),
    ).toBe("late")
  })

  test("replies after completion are discarded", async () => {
    const release = Promise.withResolvers<void>()
    const started = start(`agent("late")\nreturn "early"`, {
      onCall: async () => {
        await release.promise
        return "late"
      },
    })
    expect(await started.handle.result).toEqual({ ok: true, value: "early" })
    release.resolve()
    await Bun.sleep(20)
    started.handle.spent(5)
  })
})

describe("WorkflowSandbox bundled worker", () => {
  test("the minified worker entrypoint still runs the prelude", async () => {
    await using tmp = await tmpdir()
    const build = await Bun.build({
      entrypoints: [path.join(import.meta.dir, "../../../src/kilocode/workflow/sandbox/worker.ts")],
      target: "bun",
      minify: true,
      outdir: tmp.path,
    })
    expect(build.success).toBe(true)
    const worker = new Worker(build.outputs[0].path)
    const done = Promise.withResolvers<WorkflowProtocol.Result>()
    const init: WorkflowProtocol.Init = { args: [1, 2], total: null, spent: 0, limit: WorkflowProtocol.LIMIT }
    const body = WorkflowMeta.parse(
      HEADER +
        `const r = await pipeline(args, (x) => agent("p" + x), (prev, item, index) => prev + ":" + index)\nlet t\ntry { Date.now() } catch (e) { t = e.message }\nreturn { r, t }`,
    ).body
    worker.onmessage = (event: MessageEvent<WorkflowProtocol.Outbound>) => {
      const msg = event.data
      if (msg.type === "ready") worker.postMessage({ type: "start", body, file: FILE, init: JSON.stringify(init) })
      if (msg.type === "call" && msg.id > 0) {
        const call = JSON.parse(msg.payload) as Call
        const text = call.method === "agent" ? `r:${call.prompt}` : null
        worker.postMessage({ type: "reply", id: msg.id, ok: true, payload: JSON.stringify(text) })
      }
      if (msg.type === "done") done.resolve(JSON.parse(msg.payload))
    }
    const result = await done.promise
    worker.terminate()
    expect(result).toEqual({
      ok: true,
      value: { r: ["r:p1:0", "r:p2:1"], t: "Date.now() is unavailable in workflow scripts — pass timestamps via args" },
    })
  })
})
