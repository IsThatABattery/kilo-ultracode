/**
 * The in-context half of the workflow sandbox.
 *
 * The worker never calls `prelude` directly: it evaluates `prelude.toString()` inside the script's fresh
 * node:vm context, so every global below (JSON, Promise, Date, ...) resolves to that context's own intrinsics.
 * The function must therefore stay self-contained: no imports, no module-level constants, no helpers from
 * outside its body (the bundler would rename them and they would not exist in the context anyway).
 *
 * Security rules this file upholds:
 * - `bridge` is the only host-realm object the context ever holds, and it lives in this closure. It is only
 *   ever called directly with strings, never passed to or stored where script code can reach it.
 * - Nothing the host throws or returns reaches script code: bridge failures are rethrown as fresh in-context
 *   errors, and replies arrive as strings parsed with the JSON.parse captured here.
 * - Intrinsics the bridge relies on are captured before script code runs, so a script that patches JSON,
 *   Promise.prototype.then, Reflect or Map can only break its own run, not redirect the host channel.
 */

export type Bridge = (kind: "call" | "done", id: number, payload: string) => void

export type Api = {
  /** Run the compiled script function and report its settled value through the bridge. */
  run(main: () => unknown): void
  /** Settle the in-context promise for a host reply. */
  deliver(id: number, ok: boolean, payload: string): void
  /** Update the counter `budget.spent()` reads synchronously. */
  spend(tokens: number): void
}

type Entry = { resolve: (value: unknown) => void; reject: (err: unknown) => void }
type Stage = (prev: unknown, item: unknown, index: number) => unknown

export function prelude(bridge: Bridge, init: string): Api {
  const scope = globalThis as unknown as Record<string, unknown>
  const parse = JSON.parse
  const stringify = JSON.stringify
  const apply = Reflect.apply
  const construct = Reflect.construct
  const define = Object.defineProperty
  const freeze = Object.freeze
  const names = Object.getOwnPropertyNames
  const blank = Object.create
  const isArray = Array.isArray
  const from = Array.from
  const max = Math.max
  const Native = Promise
  const then = Promise.prototype.then
  const Fail = Error
  const Type = TypeError
  const Clock = Date
  const iterator = Symbol.iterator
  const keys = ["label", "phase", "schema", "model", "effort", "isolation", "agentType"]

  const config = parse(init) as { args?: unknown; total?: unknown; spent?: unknown; limit?: unknown }
  const total = typeof config.total === "number" ? config.total : null
  const limit = typeof config.limit === "number" ? config.limit : 4096
  const state = {
    seq: 0,
    phase: undefined as string | undefined,
    spent: typeof config.spent === "number" ? config.spent : 0,
  }
  const pending = blank(null) as Record<number, Entry | undefined>

  const resolved = (value: unknown) => new Native<unknown>((resolve) => resolve(value))
  const rejected = (err: unknown) => new Native<never>((_, reject) => reject(err))
  // Chain with the captured `then`. Its brand check throws for anything that is not a native promise; those
  // values (plain results, thenables) are adopted through a fresh promise instead.
  const on = (value: unknown, ok: (value: unknown) => unknown, bad: (err: unknown) => unknown) => {
    try {
      return apply(then, value, [ok, bad])
    } catch {
      return apply(then, resolved(value), [ok, bad])
    }
  }

  const send = (kind: "call" | "done", id: number, payload: string) => {
    try {
      bridge(kind, id, payload)
    } catch {
      // Whatever the host side raised (even a stack overflow on entry) must not reach script code as an object.
      throw new Fail("workflow sandbox bridge failed")
    }
  }

  const reason = (err: unknown) => {
    try {
      if (typeof err === "object" && err !== null && typeof (err as { message?: unknown }).message === "string")
        return (err as { message: string }).message
      return String(err)
    } catch {
      return "unknown error"
    }
  }

  const describe = (err: unknown): { error: string; stack?: string } => {
    try {
      if (typeof err !== "object" || err === null || typeof (err as { message?: unknown }).message !== "string")
        return { error: show([err]) }
      const item = err as { name?: unknown; message: string; stack?: unknown }
      const name = typeof item.name === "string" && item.name ? item.name : "Error"
      return { error: name + ": " + item.message, stack: typeof item.stack === "string" ? item.stack : undefined }
    } catch {
      return { error: "workflow script threw a value that cannot be described" }
    }
  }

  const encode = (what: string, value: unknown) => {
    try {
      return stringify(value)
    } catch (err) {
      throw new Type(what + " must be JSON-serializable: " + reason(err))
    }
  }

  /** Convert synchronous throws of an async-looking hook into rejections. */
  const lift =
    (fn: (...args: unknown[]) => Promise<unknown>) =>
    (...args: unknown[]) => {
      try {
        return apply(fn, undefined, args)
      } catch (err) {
        return rejected(err)
      }
    }

  const request = (what: string, body: Record<string, unknown>) => {
    const text = encode(what, body)
    return new Native<unknown>((resolve, reject) => {
      const id = ++state.seq
      pending[id] = { resolve, reject }
      try {
        send("call", id, text)
      } catch (err) {
        delete pending[id]
        reject(err)
      }
    })
  }

  const show = (parts: unknown[]) => {
    const out: string[] = []
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]
      if (typeof part === "string") {
        out[i] = part
        continue
      }
      try {
        const json = stringify(part)
        out[i] = typeof json === "string" ? json : String(part)
      } catch {
        out[i] = reason(part)
      }
    }
    return out.join(" ")
  }

  const list = (value: unknown, name: string) => {
    const items = isArray(value)
      ? value
      : value !== null && value !== undefined && typeof (value as Record<symbol, unknown>)[iterator] === "function"
        ? from(value as Iterable<unknown>)
        : undefined
    if (!items) throw new Type(name + "() expects an array")
    if (items.length > limit)
      throw new Fail(
        name +
          "() accepts at most " +
          limit +
          " items per call (got " +
          items.length +
          "); split the work into smaller batches",
      )
    return items as unknown[]
  }

  /** Promise.all without consulting user-patchable Promise statics; `step` never rejects. */
  const gather = (items: unknown[], step: (item: unknown, index: number) => Promise<unknown>) =>
    new Native<unknown[]>((resolve) => {
      const out: unknown[] = []
      const count = items.length
      const left = { count }
      if (count === 0) return resolve(out)
      for (let i = 0; i < count; i++) {
        out[i] = null
        void on(
          step(items[i], i),
          (value) => {
            out[i] = value
            left.count--
            if (left.count === 0) resolve(out)
          },
          () => {
            left.count--
            if (left.count === 0) resolve(out)
          },
        )
      }
    })

  const agent = lift((prompt: unknown, opts?: unknown) => {
    if (typeof prompt !== "string") return rejected(new Type("agent() prompt must be a string"))
    if (opts !== undefined && opts !== null && typeof opts !== "object")
      return rejected(new Type("agent() opts must be an object"))
    const source = (opts ?? {}) as Record<string, unknown>
    const picked: Record<string, unknown> = {}
    // null and undefined both mean "inherit" (`opts.phase ?? currentPhase`).
    for (let i = 0; i < keys.length; i++) {
      const value = source[keys[i]]
      if (value !== undefined && value !== null) picked[keys[i]] = value
    }
    if (picked.phase === undefined && state.phase !== undefined) picked.phase = state.phase
    return request("agent() opts", { method: "agent", prompt, opts: picked })
  })

  const parallel = lift((thunks: unknown) => {
    const items = list(thunks, "parallel")
    return gather(items, (item) => {
      try {
        return on(
          typeof item === "function" ? (item as () => unknown)() : item,
          (value) => value,
          () => null,
        )
      } catch {
        return resolved(null)
      }
    })
  })

  const pipeline = lift((items: unknown, ...stages: unknown[]) => {
    const work = list(items, "pipeline")
    for (let i = 0; i < stages.length; i++)
      if (typeof stages[i] !== "function") throw new Type("pipeline() stage " + (i + 1) + " must be a function")
    const steps = stages as Stage[]
    // Each item walks every stage on its own: no barrier between stages, a throwing stage drops the item to null.
    const advance = (prev: unknown, item: unknown, index: number, at: number): Promise<unknown> => {
      if (at === steps.length) return resolved(prev)
      const stage = steps[at]
      try {
        return on(
          stage(prev, item, index),
          (value) => advance(value, item, index, at + 1),
          () => null,
        )
      } catch {
        return resolved(null)
      }
    }
    return gather(work, (item, index) => advance(item, item, index, 0))
  })

  const workflow = lift((ref: unknown, args?: unknown) => {
    const path = typeof ref === "object" && ref !== null ? (ref as { scriptPath?: unknown }).scriptPath : undefined
    const target = typeof ref === "string" ? ref : typeof path === "string" ? { scriptPath: path } : undefined
    if (target === undefined) return rejected(new Type("workflow() expects a saved workflow name or { scriptPath }"))
    return request(
      "workflow() args",
      args === undefined ? { method: "workflow", ref: target } : { method: "workflow", ref: target, args },
    )
  })

  const log = (...parts: unknown[]) => {
    send("call", 0, stringify({ method: "log", message: show(parts) }))
  }

  const phase = (title: unknown) => {
    if (typeof title !== "string") throw new Type("phase() title must be a string")
    state.phase = title
    send("call", 0, stringify({ method: "phase", title }))
  }

  const budget = freeze({
    total,
    spent: () => state.spent,
    remaining: () => (total === null ? Infinity : max(0, total - state.spent)),
  })

  // Determinism: wall-clock time and randomness would make journal replay (resume) diverge.
  const unavailable = (what: string, hint: string) => () => {
    throw new Fail(what + " is unavailable in workflow scripts — " + hint)
  }
  const now = unavailable("Date.now()", "pass timestamps via args")
  function Stamp(...args: unknown[]) {
    if (!new.target) throw new Fail("Date() is unavailable in workflow scripts — pass timestamps via args")
    if (args.length === 0) throw new Fail("new Date() is unavailable in workflow scripts — pass timestamps via args")
    return construct(Clock, args, new.target) as object
  }
  define(Stamp, "prototype", { value: Clock.prototype })
  define(Stamp, "name", { value: "Date" })
  define(Stamp, "length", { value: 7 })
  define(Stamp, "now", { value: now, writable: true, configurable: true })
  define(Stamp, "UTC", { value: Clock.UTC, writable: true, configurable: true })
  define(Stamp, "parse", { value: Clock.parse, writable: true, configurable: true })
  define(Clock.prototype, "constructor", { value: Stamp, writable: true, configurable: true })
  define(scope, "Date", { value: Stamp, writable: true, configurable: true })
  define(Math, "random", {
    value: unavailable("Math.random()", "vary the agent prompt/label by index instead"),
    writable: true,
    configurable: true,
  })
  const temporal = scope.Temporal
  if (typeof temporal === "object" && temporal !== null) {
    const live = (temporal as { Now?: unknown }).Now
    const stub: Record<string, unknown> = {}
    const methods = typeof live === "object" && live !== null ? names(live) : []
    for (let i = 0; i < methods.length; i++)
      stub[methods[i]] = unavailable("Temporal.Now." + methods[i] + "()", "pass timestamps via args")
    define(temporal, "Now", { value: freeze(stub), writable: true, configurable: true })
  }
  // GC-driven callbacks are nondeterministic, and a throwing FinalizationRegistry callback is uncatchable.
  delete scope.FinalizationRegistry
  delete scope.WeakRef
  // V8-style CallSite objects expose frame functions; a sloppy host frame would hand out the host realm.
  define(Fail, "prepareStackTrace", { value: undefined, writable: false, configurable: false })

  const expose = (name: string, value: unknown) =>
    define(scope, name, { value, writable: true, configurable: true, enumerable: false })
  expose("agent", agent)
  expose("parallel", parallel)
  expose("pipeline", pipeline)
  expose("workflow", workflow)
  expose("phase", phase)
  expose("log", log)
  expose("args", config.args)
  expose("budget", budget)
  // The context's native console writes to the host process' stdio (and would corrupt the TUI); narrate instead.
  expose("console", freeze({ log, info: log, warn: log, error: log, debug: log }))

  const finish = (payload: string) => send("done", 0, payload)

  const fail = (err: unknown) => {
    const info = describe(err)
    finish(stringify({ ok: false, error: info.error, stack: info.stack }))
  }

  const succeed = (value: unknown) => {
    if (typeof value === "function" || typeof value === "symbol" || typeof value === "bigint")
      return finish(stringify({ ok: false, error: "workflow result is not JSON-serializable (" + typeof value + ")" }))
    try {
      const text = stringify(value)
      return finish(text === undefined ? '{"ok":true}' : '{"ok":true,"value":' + text + "}")
    } catch (err) {
      return finish(stringify({ ok: false, error: "workflow result is not JSON-serializable: " + reason(err) }))
    }
  }

  const run = (main: () => unknown) => {
    const result = (() => {
      try {
        return main()
      } catch (err) {
        return rejected(err)
      }
    })()
    void on(
      on(result, succeed, fail),
      (value) => value,
      () => finish('{"ok":false,"error":"workflow sandbox failed to report the script result"}'),
    )
  }

  const deliver = (id: number, ok: boolean, payload: string) => {
    const entry = pending[id]
    if (!entry) return
    delete pending[id]
    if (!ok) return entry.reject(new Fail(payload))
    if (payload === "") return entry.resolve(undefined)
    try {
      entry.resolve(parse(payload))
    } catch {
      entry.reject(new Fail("workflow host returned a result that is not valid JSON"))
    }
  }

  const spend = (tokens: number) => {
    if (typeof tokens === "number" && tokens >= 0) state.spent = tokens
  }

  return freeze({ run, deliver, spend })
}
