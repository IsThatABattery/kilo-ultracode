import os from "os"
import * as Log from "@opencode-ai/core/util/log"
import type { AgentOpts, Call } from "../types"
import { WorkflowProtocol } from "./protocol"

declare global {
  const KILO_WORKFLOW_WORKER_PATH: string
}

export namespace WorkflowSandbox {
  export type Result = { ok: true; value: unknown } | { ok: false; error: string }

  export type Input = {
    /** Executable body from WorkflowMeta.parse. */
    body: string
    /** JSON-serializable `args` global. */
    args: unknown
    /** `budget.total` (null when no token target). */
    total: number | null
    /** Shown in stack traces / errors. */
    file: string
    /**
     * Host handler for script calls. `agent`/`workflow` resolve to the JSON-serializable value the script receives
     * (null allowed) or reject with an Error whose message the script sees as a thrown Error. `log`/`phase` are
     * fire-and-forget (their promise result is ignored).
     */
    onCall: (call: Call) => Promise<unknown>
    /** Liveness probe: ping every `interval` ms, kill the run once pings went unanswered for `timeout` ms. Default 5s / 60s. */
    watchdog?: { interval: number; timeout: number }
    /** Process RSS (bytes) above which the run is killed. Default: see `ceiling`. */
    memory?: number
  }

  export type Handle = {
    result: Promise<Result>
    /** Push the current budget.spent() value into the sandbox so the script can read it synchronously. */
    spent(tokens: number): void
    /** Kill the sandbox immediately; `result` resolves with { ok: false, error: "stopped" }. */
    terminate(): void
  }

  export const UNRESPONSIVE = "workflow script unresponsive (busy loop?)"
  export const STOPPED = "stopped"
  export const MEMORY = "workflow script exceeded the memory limit"
  export const FLOOD = "workflow script is flooding calls without yielding (missing await?)"
  export const MALFORMED = "workflow call is malformed"

  /** Script calls accepted between two answered pings: a loop calling log()/agent() without awaiting never yields. */
  export const FLOOD_LIMIT = 50_000
  /** How often the memory guard samples the process RSS (a tight allocation loop grows it by GB/s). */
  const SAMPLE = 100
  /** Room every run gets above the RSS the process already had when it started. */
  const HEADROOM = 512 * 1024 * 1024

  /**
   * Process RSS (bytes) a run may push the process to: KILO_WORKFLOW_MAX_RSS_MB, else half of the machine's (or
   * container's) memory. The sandbox is a Worker inside the shared `kilo serve` process and Bun Workers have no heap
   * limit, so this backstop kills a runaway script before the OS kills the whole server.
   */
  export function ceiling() {
    const value = Number(process.env.KILO_WORKFLOW_MAX_RSS_MB)
    if (Number.isFinite(value) && value > 0) return value * 1024 * 1024
    const limit = process.constrainedMemory?.() ?? 0
    const total = limit > 0 ? Math.min(limit, os.totalmem()) : os.totalmem()
    return Math.floor(total / 2)
  }

  const log = Log.create({ service: "workflow-sandbox" })

  // Compiled binaries embed the worker as its own entrypoint (script/build.ts); source runs load it directly.
  const target = () =>
    typeof KILO_WORKFLOW_WORKER_PATH !== "undefined"
      ? KILO_WORKFLOW_WORKER_PATH
      : new URL("./worker.ts", import.meta.url)

  const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

  const record = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value)

  const KEYS = new Set<string>(["label", "phase", "schema", "model", "effort", "isolation", "agentType"])

  /**
   * A decoded call in its exact shape, or undefined. The prelude builds well-formed calls, but script code shares
   * the context with it, so the host never trusts what arrives (option values are checked by WorkflowSpawn.check).
   */
  export function validate(value: unknown): Call | undefined {
    if (!record(value)) return undefined
    if (value.method === "log")
      return typeof value.message === "string" ? { method: "log", message: value.message } : undefined
    if (value.method === "phase")
      return typeof value.title === "string" ? { method: "phase", title: value.title } : undefined
    if (value.method === "agent") {
      const opts = value.opts ?? {}
      if (typeof value.prompt !== "string" || !record(opts)) return undefined
      const picked = Object.fromEntries(Object.entries(opts).filter((entry) => KEYS.has(entry[0])))
      return { method: "agent", prompt: value.prompt, opts: picked as AgentOpts }
    }
    if (value.method !== "workflow") return undefined
    const ref = value.ref
    const target =
      typeof ref === "string"
        ? ref
        : record(ref) && typeof ref.scriptPath === "string"
          ? { scriptPath: ref.scriptPath }
          : undefined
    if (target === undefined) return undefined
    return value.args === undefined
      ? { method: "workflow", ref: target }
      : { method: "workflow", ref: target, args: value.args }
  }

  /** Append the first script frame (`file:line:col`) found in a stack trace. */
  const locate = (error: string, stack: string | undefined, file: string) => {
    if (!stack) return error
    const marker = file + ":"
    const line = stack.split("\n").find((item) => item.includes(marker))
    const spot = line?.slice(line.indexOf(marker) + marker.length).match(/^(\d+):(\d+)/)
    if (!spot) return error
    return `${error} (at ${file}:${spot[1]}:${spot[2]})`
  }

  const decode = (payload: string, file: string): Result => {
    const parsed = (() => {
      try {
        return JSON.parse(payload) as unknown
      } catch (err) {
        return { ok: false, error: `workflow result could not be decoded: ${message(err)}` }
      }
    })()
    if (!record(parsed) || typeof parsed.ok !== "boolean") return { ok: false, error: "workflow result is malformed" }
    if (parsed.ok) return { ok: true, value: parsed.value }
    const error = typeof parsed.error === "string" ? parsed.error : "workflow script failed"
    return { ok: false, error: locate(error, typeof parsed.stack === "string" ? parsed.stack : undefined, file) }
  }

  const encode = (value: unknown) => {
    const text = JSON.stringify(value)
    return text === undefined ? "" : text
  }

  /** Start a sandboxed run in a dedicated Worker hosting a node:vm context (contract owned by the sandbox unit). */
  export function start(input: Input): Handle {
    const watch = input.watchdog ?? { interval: 5_000, timeout: 60_000 }
    const limit = input.memory ?? Math.max(ceiling(), process.memoryUsage.rss() + HEADROOM)
    const done = Promise.withResolvers<Result>()
    // `missed`: pings sent since the last pong. `calls`: calls received since then.
    const state = { settled: false, ready: false, spent: 0, missed: 0, calls: 0 }
    const worker = new Worker(target())

    const finish = (result: Result) => {
      if (state.settled) return
      state.settled = true
      clearInterval(timer)
      clearInterval(guard)
      worker.terminate()
      done.resolve(result)
    }

    // Bun drops messages posted before the worker listens, so nothing but `start` goes out until it says ready.
    const post = (msg: WorkflowProtocol.Inbound) => {
      if (state.settled || !state.ready) return
      worker.postMessage(msg)
    }

    const reply = (id: number, ok: boolean, payload: string) => post({ type: "reply", id, ok, payload })

    const route = (id: number, payload: string) => {
      const decoded = (() => {
        try {
          return { value: JSON.parse(payload) as unknown }
        } catch (err) {
          log.error("workflow sandbox sent an invalid call", { err })
          return undefined
        }
      })()
      if (!decoded) return id > 0 ? reply(id, false, "workflow call could not be decoded") : undefined
      const call = validate(decoded.value)
      if (!call) {
        if (id > 0) return reply(id, false, MALFORMED)
        return log.warn("workflow sandbox sent a malformed call")
      }
      // Invoke synchronously so the host sees calls in the order the script made them.
      const pending = (() => {
        try {
          return Promise.resolve(input.onCall(call))
        } catch (err) {
          return Promise.reject(err)
        }
      })()
      pending.then(
        (value) => {
          if (id === 0) return
          const text = (() => {
            try {
              return { ok: true, payload: encode(value) }
            } catch (err) {
              return { ok: false, payload: `${call.method}() result is not JSON-serializable: ${message(err)}` }
            }
          })()
          reply(id, text.ok, text.payload)
        },
        (err) => {
          if (id === 0) return log.error("workflow call failed", { method: call.method, err })
          reply(id, false, message(err))
        },
      )
    }

    worker.onmessage = (event: MessageEvent<WorkflowProtocol.Outbound>) => {
      // Messages a flooding worker queued before terminate() must not start agents.
      if (state.settled) return
      const msg = event.data
      // Only answers to pings prove the worker's event loop still turns; a synchronous loop can keep posting calls.
      if (msg.type === "pong" || msg.type === "ready") {
        state.missed = 0
        state.calls = 0
      }
      if (msg.type === "ready") {
        if (state.ready) return
        state.ready = true
        const init = (() => {
          try {
            const value: WorkflowProtocol.Init = {
              args: input.args,
              total: input.total,
              spent: state.spent,
              limit: WorkflowProtocol.LIMIT,
            }
            return JSON.stringify(value)
          } catch (err) {
            finish({ ok: false, error: `workflow args must be JSON-serializable: ${message(err)}` })
            return undefined
          }
        })()
        if (init === undefined) return
        post({ type: "start", body: input.body, file: input.file, init })
        return
      }
      if (msg.type === "call") {
        state.calls += 1
        if (state.calls > FLOOD_LIMIT) return finish({ ok: false, error: FLOOD })
        return route(msg.id, msg.payload)
      }
      if (msg.type === "done") return finish(decode(msg.payload, input.file))
    }
    worker.onerror = (event) => {
      log.error("workflow sandbox worker error", { message: event.message })
      finish({ ok: false, error: `workflow sandbox crashed: ${event.message}` })
    }
    worker.addEventListener("close", () => finish({ ok: false, error: "workflow sandbox exited unexpectedly" }))

    // The worker answers pings from its event loop, so a script stuck in a synchronous loop (or an endless
    // microtask chain) leaves them unanswered; terminate() is the only way to stop it. Counting unanswered pings
    // instead of measuring silence keeps a suspended host process (ctrl+z) from killing healthy runs on resume.
    const timer = setInterval(() => {
      state.missed += 1
      if (state.missed * watch.interval > watch.timeout) return finish({ ok: false, error: UNRESPONSIVE })
      post({ type: "ping" })
    }, watch.interval)
    timer.unref?.()

    // A synchronous allocation loop grows the shared process by GB/s, far faster than the watchdog fires.
    const guard = setInterval(() => {
      const rss = process.memoryUsage.rss()
      if (rss <= limit) return
      log.warn("workflow sandbox exceeded the memory limit", { rss, limit })
      finish({ ok: false, error: MEMORY })
    }, SAMPLE)
    guard.unref?.()

    return {
      result: done.promise,
      spent(tokens) {
        state.spent = tokens
        post({ type: "spent", tokens })
      },
      terminate() {
        finish({ ok: false, error: STOPPED })
      },
    }
  }
}
