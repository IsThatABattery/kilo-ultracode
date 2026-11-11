/**
 * Backend workflow run shapes → the webview's WorkflowRun / WorkflowRunDetail.
 * Kept free of other imports so both the SSE mapper and the request router can use it.
 */

import type { WorkflowAgentInfo, WorkflowRunDetail as Detail, WorkflowRunInfo as Info } from "@kilocode/sdk/v2/client"
import type { WorkflowAgent, WorkflowRun, WorkflowRunDetail } from "../../webview-ui/src/types/messages/workflow"

// Effect's Schema.Number also admits NaN and the infinities, which the SDK types spell as strings.
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
