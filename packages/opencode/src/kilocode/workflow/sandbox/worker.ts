// Workflow sandbox worker: hosts one script in a fresh node:vm context. Started by WorkflowSandbox.start.
// Keep imports minimal: this file is its own build entrypoint and must be listening before any await.
import vm from "node:vm"
import { WorkflowProtocol } from "./protocol"
import { prelude, type Api } from "./prelude"

declare const self: Worker

const post = (message: WorkflowProtocol.Outbound) => self.postMessage(message)

const state: { api?: Api; started: boolean } = { started: false }

const report = (error: string) => post({ type: "done", payload: JSON.stringify({ ok: false, error }) })

// Script code can leave rejected agent()/parallel() promises un-awaited. Bun would treat that as fatal and kill
// the worker, so swallow them here: the script's own result is what counts. Never inspect the reason, it may be
// a script object whose getters would run with host frames on the stack.
process.on("unhandledRejection", () => undefined)
// Anything uncaught at this point escaped the prelude's bookkeeping; end the run instead of dying silently.
process.on("uncaughtException", (err) =>
  report(`workflow sandbox failed: ${err instanceof Error ? err.message : "uncaught exception"}`),
)

/** The single host function the context can reach (through a prelude closure only). Never throws, returns nothing. */
const bridge = (kind: unknown, id: unknown, payload: unknown) => {
  try {
    if (typeof payload !== "string") return
    if (kind === "call" && typeof id === "number") post({ type: "call", id, payload })
    if (kind === "done") post({ type: "done", payload })
  } catch (err) {
    console.error("workflow sandbox bridge failed", err)
  }
}

const start = (message: Extract<WorkflowProtocol.Inbound, { type: "start" }>) => {
  if (state.started) return
  state.started = true
  try {
    // A null-prototype sandbox: Bun resolves context-global lookups that miss through the object passed here, so a
    // plain `{}` would hand script code host-realm members (`constructor`, `valueOf`, `__proto__`, ...) whose
    // constructor chain reaches the host's Function, which `codeGeneration: { strings: false }` does not cover.
    const context = vm.createContext(Object.create(null), { codeGeneration: { strings: false, wasm: false } })
    const install = vm.runInContext(`"use strict";(${prelude.toString()})`, context, {
      filename: WorkflowProtocol.PRELUDE,
    }) as typeof prelude
    const api = install(bridge, message.init)
    // Read the methods now, before any script code runs in the context.
    state.api = { run: api.run, deliver: api.deliver, spend: api.spend }
    const script = new vm.Script(WorkflowProtocol.PREFIX + message.body + WorkflowProtocol.SUFFIX, {
      filename: message.file,
    })
    const main: unknown = script.runInContext(context)
    if (typeof main !== "function") return report("workflow script did not compile to a function")
    state.api.run(main as () => unknown)
  } catch (err) {
    // Host-realm errors only (compile failure, prelude install): the script never sees these objects.
    report(err instanceof Error ? `${err.name}: ${err.message}` : String(err))
  }
}

self.onmessage = (event: MessageEvent<WorkflowProtocol.Inbound>) => {
  const message = event.data
  if (message.type === "ping") return post({ type: "pong" })
  if (message.type === "start") return start(message)
  if (message.type === "spent") return state.api?.spend(message.tokens)
  if (message.type !== "reply") return
  try {
    state.api?.deliver(message.id, message.ok, message.payload)
  } catch (err) {
    // deliver only settles in-context promises; a throw here means the context is broken, not the host.
    console.error("workflow sandbox reply failed", typeof err)
  }
}

post({ type: "ready" })
