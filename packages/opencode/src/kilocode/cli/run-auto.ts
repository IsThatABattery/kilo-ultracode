// kilocode_change - new file
import type { GlobalEvent, KiloClient } from "@kilocode/sdk/v2"
import * as Log from "@opencode-ai/core/util/log"

const log = Log.create({ service: "run.auto" })

export namespace KiloRunAuto {
  /** Session metadata key of a workflow agent's child session (WorkflowSpawn.METADATA). */
  export const WORKFLOW = "kilo.workflow"

  export interface State {
    root: string
    sessions: Set<string>
    /** A tracked subagent ask from another directory was auto-rejected, so the run must fail. */
    rejected: boolean
  }

  export interface Part {
    type?: string
    tool?: string
    sessionID?: string
    state?: unknown
  }

  export interface Session {
    id: string
    parentID?: string
    metadata?: Record<string, unknown>
  }

  export type Reply = "once" | "reject"

  export interface Watch {
    state: State
    /** The run's own directory: the run loop answers its events from the directory-scoped stream. */
    directory: string
    events: AsyncIterable<GlobalEvent>
    /** --auto / --yolo: approve tracked asks once; otherwise reject them and fail the run. */
    approve: boolean
    reply: (input: { requestID: string; directory: string; reply: Reply }) => Promise<unknown>
    /** Reports an auto-rejected subagent ask. */
    warn: (text: string) => void
  }

  export function create(root: string): State {
    return {
      root,
      sessions: new Set([root]),
      rejected: false,
    }
  }

  export function allowed(state: State, sessionID: string) {
    return state.sessions.has(sessionID)
  }

  export function track(state: State, part: Part) {
    if (part.type !== "tool") return
    if (part.tool !== "task") return
    if (!part.sessionID || !state.sessions.has(part.sessionID)) return
    const id = child(meta(part.state))
    if (!id) return
    state.sessions.add(id)
  }

  /** Track a workflow agent's child session (from session.created) once the session that launched it is tracked. */
  export function session(state: State, info: Session) {
    if (!info.id || !info.parentID || !state.sessions.has(info.parentID)) return
    const mark = info.metadata?.[WORKFLOW]
    if (!mark || typeof mark !== "object") return
    state.sessions.add(info.id)
  }

  /**
   * Answer tracked sessions' permission asks published under other directories. Workflow agents with
   * isolation: 'worktree' run in their worktree's instance, so neither their session.created nor their
   * permission.asked reaches the run's directory-scoped event stream.
   */
  export async function watch(input: Watch) {
    for await (const event of input.events) {
      if (!event.directory || event.directory === input.directory) continue
      const payload = event.payload
      if (payload.type === "session.created") {
        session(input.state, payload.properties.info)
        continue
      }
      if (payload.type !== "permission.asked") continue
      const ask = payload.properties
      if (!allowed(input.state, ask.sessionID)) continue
      // Skill shell batches and sandbox escalations need an interactive human decision, as in the run loop.
      const sensitive = ask.metadata?.["skillShell"] === true || ask.metadata?.["sandboxEscalation"] === true
      if (!sensitive && !input.approve) {
        input.state.rejected = true
        input.warn(`subagent permission requested: ${ask.permission} (${ask.patterns.join(", ")}); auto-rejecting`)
      }
      await input
        .reply({
          requestID: ask.id,
          directory: event.directory,
          reply: input.approve && !sensitive ? "once" : "reject",
        })
        .catch((err: unknown) => log.error("failed to answer a cross-directory permission ask", { id: ask.id, err }))
    }
  }

  /** Run `watch` over the server's global event stream until `signal` aborts; failures only end the watch. */
  export function global(client: KiloClient, input: Omit<Watch, "events" | "reply"> & { signal: AbortSignal }) {
    const run = async () => {
      const events = await client.global.event({
        signal: input.signal,
        sseMaxRetryAttempts: 1,
        onSseError: (err) => {
          if (!input.signal.aborted) log.warn("global event stream failed", { err })
        },
      })
      await watch({ ...input, events: events.stream, reply: (item) => client.permission.reply(item) })
    }
    return run().catch((err: unknown) => {
      log.error("failed to answer cross-directory permission asks", { err })
    })
  }

  function meta(state: unknown) {
    if (!state || typeof state !== "object") return
    return (state as Record<string, unknown>).metadata
  }

  function child(meta: unknown) {
    if (!meta || typeof meta !== "object") return
    const id = (meta as Record<string, unknown>).sessionId
    if (typeof id !== "string") return
    if (!id) return
    return id
  }
}
