/** Messages between WorkflowSandbox (main thread) and the sandbox worker. All script data travels as JSON strings. */
export namespace WorkflowProtocol {
  /** Opens the script body on its first line so stack-trace line numbers match the script file. */
  export const PREFIX = '(async () => {"use strict";'
  export const SUFFIX = "\n})"
  /** Filename the in-context prelude is compiled under (shows up in stack frames instead of the script file). */
  export const PRELUDE = "kilo:workflow-prelude"
  /** Max items accepted by one parallel()/pipeline() call (sent to the prelude in `Init`, it cannot import). */
  export const LIMIT = 4096

  /** JSON shape of `Start.init`. */
  export type Init = { args?: unknown; total: number | null; spent: number; limit: number }

  /** JSON shape of `Done.payload`. */
  export type Result = { ok: true; value?: unknown } | { ok: false; error: string; stack?: string }

  export type Inbound =
    | { type: "start"; body: string; file: string; init: string }
    /** `payload`: JSON text of the value ("" for undefined) when ok, else the error message the script sees. */
    | { type: "reply"; id: number; ok: boolean; payload: string }
    | { type: "spent"; tokens: number }
    | { type: "ping" }

  export type Outbound =
    | { type: "ready" }
    | { type: "pong" }
    /** `id` 0 marks fire-and-forget calls (log/phase) that get no reply. `payload` is JSON of a `Call`. */
    | { type: "call"; id: number; payload: string }
    | { type: "done"; payload: string }
}
