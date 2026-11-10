import type { Call } from "../types"

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
  }

  export type Handle = {
    result: Promise<Result>
    /** Push the current budget.spent() value into the sandbox so the script can read it synchronously. */
    spent(tokens: number): void
    /** Kill the sandbox immediately; `result` resolves with { ok: false, error: "stopped" }. */
    terminate(): void
  }

  /** Start a sandboxed run in a dedicated Worker hosting a node:vm context (contract owned by the sandbox unit). */
  export function start(input: Input): Handle {
    throw new Error(`unimplemented: ${input.file}`)
  }
}
