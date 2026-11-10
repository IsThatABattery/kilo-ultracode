import * as Log from "@opencode-ai/core/util/log"
import type { Call } from "../types"
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
    /** Liveness probe: ping every `interval` ms, kill the run after `timeout` ms of silence. Default 5s / 60s. */
    watchdog?: { interval: number; timeout: number }
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

  const log = Log.create({ service: "workflow-sandbox" })

  // Compiled binaries embed the worker as its own entrypoint (script/build.ts); source runs load it directly.
  const target = () =>
    typeof KILO_WORKFLOW_WORKER_PATH !== "undefined"
      ? KILO_WORKFLOW_WORKER_PATH
      : new URL("./worker.ts", import.meta.url)

  const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

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
        return JSON.parse(payload) as WorkflowProtocol.Result
      } catch (err) {
        return { ok: false as const, error: `workflow result could not be decoded: ${message(err)}` }
      }
    })()
    if (parsed.ok) return { ok: true, value: parsed.value }
    return { ok: false, error: locate(parsed.error, parsed.stack, file) }
  }

  const encode = (value: unknown) => {
    const text = JSON.stringify(value)
    return text === undefined ? "" : text
  }

  /** Start a sandboxed run in a dedicated Worker hosting a node:vm context (contract owned by the sandbox unit). */
  export function start(input: Input): Handle {
    const watch = input.watchdog ?? { interval: 5_000, timeout: 60_000 }
    const done = Promise.withResolvers<Result>()
    const state = { settled: false, ready: false, spent: 0, last: performance.now() }
    const worker = new Worker(target())

    const finish = (result: Result) => {
      if (state.settled) return
      state.settled = true
      clearInterval(timer)
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
      const call = (() => {
        try {
          return JSON.parse(payload) as Call
        } catch (err) {
          log.error("workflow sandbox sent an invalid call", { err })
          return undefined
        }
      })()
      if (!call) return id > 0 ? reply(id, false, "workflow call could not be decoded") : undefined
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
      state.last = performance.now()
      const msg = event.data
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
      if (msg.type === "call") return route(msg.id, msg.payload)
      if (msg.type === "done") return finish(decode(msg.payload, input.file))
    }
    worker.onerror = (event) => {
      log.error("workflow sandbox worker error", { message: event.message })
      finish({ ok: false, error: `workflow sandbox crashed: ${event.message}` })
    }
    worker.addEventListener("close", () => finish({ ok: false, error: "workflow sandbox exited unexpectedly" }))

    // The worker answers pings from its event loop, so a script stuck in a synchronous loop (or an endless
    // microtask chain) goes silent; terminate() is the only way to stop it.
    const timer = setInterval(() => {
      if (performance.now() - state.last > watch.timeout) return finish({ ok: false, error: UNRESPONSIVE })
      post({ type: "ping" })
    }, watch.interval)
    timer.unref?.()

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
