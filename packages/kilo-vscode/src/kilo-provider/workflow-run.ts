/**
 * Backend workflow run shapes → the webview's WorkflowRun / WorkflowRunDetail.
 * Kept free of imports that pull in the provider, so both the SSE mapper and the request router can use it.
 */

import type {
  KiloClient,
  Session,
  WorkflowAgentInfo,
  WorkflowRunDetail as Detail,
  WorkflowRunInfo as Info,
} from "@kilocode/sdk/v2/client"
import type { WorkflowAgent, WorkflowRun, WorkflowRunDetail } from "../../webview-ui/src/types/messages/workflow"
import { childID } from "./task-session"

// The backend sends finite numbers; anything else (a malformed or hand-edited run.json) reads as unset.
function time(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

/** The run summary the webview renders, with plain numbers. */
export function toRun(info: Info): WorkflowRun {
  return {
    id: info.id,
    sessionID: info.sessionID,
    name: info.name,
    description: info.description,
    status: info.status,
    phases: info.phases,
    agents: info.agents,
    running: info.running,
    done: info.done,
    error: info.error,
    skipped: info.skipped,
    cached: info.cached,
    tokens: info.tokens,
    tools: info.tools,
    size: info.size,
    started: time(info.started) ?? 0,
    ended: time(info.ended),
    dir: info.dir,
    error_message: info.error_message,
  }
}

function agent(info: WorkflowAgentInfo): WorkflowAgent {
  return {
    id: info.id,
    index: info.index,
    label: info.label,
    phase: info.phase,
    group: info.group,
    status: info.status,
    sessionID: info.sessionID,
    model: info.model,
    tokens: info.tokens,
    tools: info.tools,
    started: time(info.started),
    ended: time(info.ended),
    error: info.error,
  }
}

/** Run detail without the prompts, results and logs the card never shows. */
export function toDetail(info: Detail): WorkflowRunDetail {
  return { ...toRun(info), list: info.list.map(agent) }
}

/**
 * A workflow agent's child session whose launching session this webview tracks.
 * Tracking it lets the agent's permission and question prompts reach the chat,
 * which shows them for the whole session family.
 */
export function workflowAgent(
  info: { parentID?: string | null; metadata?: Record<string, unknown> },
  tracked: (sessionID: string) => boolean,
) {
  return !!info.parentID && !!info.metadata?.["kilo.workflow"] && tracked(info.parentID)
}

/**
 * The sessions of the running agents in a session's runs that are still going (running or paused).
 * A panel adopts agents from their live session.created event, so one that opens, reloads or reconnects
 * mid-run never saw the agents already running; it adopts them from here. Each session carries its own
 * directory, which is its worktree for an agent run with isolation: 'worktree'. `complete` is false when
 * a request failed, so the caller checks the session again later.
 */
export async function runningAgents(
  client: Pick<KiloClient, "workflow" | "session">,
  sessionID: string,
  directory: string,
  known: (sessionID: string) => boolean,
) {
  const state = { complete: true }
  const fail = (err: unknown) => {
    state.complete = false
    console.warn("[Kilo New] Failed to load workflow runs:", err)
    return undefined
  }
  const runs = await client.workflow
    .list({ sessionID, directory }, { throwOnError: true })
    .then((res) => res.data, fail)
  const live = (runs ?? []).filter((run) => run.status === "running" || run.status === "paused")
  const details = await Promise.all(
    live.map((run) =>
      client.workflow.get({ runID: run.id, directory }, { throwOnError: true }).then((res) => res.data, fail),
    ),
  )
  const ids = details.flatMap(
    (detail) =>
      detail?.list.flatMap((agent) =>
        agent.status === "running" && agent.sessionID && !known(agent.sessionID) ? [agent.sessionID] : [],
      ) ?? [],
  )
  const sessions = await Promise.all(
    ids.map((id) =>
      client.session.get({ sessionID: id, directory }, { throwOnError: true }).then((res) => res.data, fail),
    ),
  )
  return { sessions: sessions.filter((session): session is Session => !!session), complete: state.complete }
}

// Events of a workflow agent that still matter while no surface shows its transcript.
const BACKGROUND = new Set([
  "permission.asked",
  "permission.replied",
  "question.asked",
  "question.replied",
  "question.rejected",
  "suggestion.shown",
  "suggestion.accepted",
  "suggestion.dismissed",
  "session.status",
  "session.wakeup",
  "session.deleted",
])

/**
 * Whether an event of a workflow agent nobody views still reaches its panel: its prompts, status and
 * deletion, and the part updates that reveal a nested task child or finish a step. A run can have up
 * to 1000 agents, so the rest of their transcripts stays on the backend until one is opened.
 */
export function workflowBackground(event: { type: string; properties?: unknown }) {
  if (BACKGROUND.has(event.type)) return true
  if (event.type !== "message.part.updated") return false
  const part = (event.properties as { part?: Parameters<typeof childID>[0] } | undefined)?.part
  return !!part && (part.type === "step-finish" || childID(part) !== undefined)
}
