import { Effect } from "effect"
import type { TaskPromptOps } from "@/tool/task"
import type { AgentOpts, Outcome } from "./types"

export namespace WorkflowSpawn {
  export type Input = {
    /** The tool call that launched the run (parent session context). */
    parent: { sessionID: string; messageID: string; agent: string }
    /** Captured from the launching tool call's ctx.extra.promptOps. */
    ops: TaskPromptOps
    run: { id: string; name: string }
    agent: { id: string; index: number; label: string; prompt: string; opts: AgentOpts }
    /** Called as soon as the child session exists (UI drill-down, stop). */
    onSession?: (sessionID: string) => void
  }

  /**
   * Validate opts before any agent starts (unknown agentType, primary agent, unsatisfiable schema, …).
   * Returns an error message, or undefined when valid. Contract owned by the spawn unit.
   */
  export function check(opts: AgentOpts): string | undefined {
    return opts.agentType === "" ? "empty agentType" : undefined
  }

  /**
   * Run one workflow agent to completion in a child session of `parent.sessionID` and return its outcome.
   * Interrupting the returned effect cancels the child session and yields { status: "skipped" } semantics to the caller.
   * Contract owned by the spawn unit; `make` may require services — the run service provides them.
   */
  export const make = Effect.succeed((input: Input): Effect.Effect<Outcome> => Effect.die(`unimplemented: ${input.agent.id}`))
}
