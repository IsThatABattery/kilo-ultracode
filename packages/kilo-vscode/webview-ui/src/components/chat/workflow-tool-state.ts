/**
 * Pure helpers for the workflow tool card: which controls a run offers, how its
 * agents are listed, and when the card should reload the agent list.
 */

import type { WorkflowAgent, WorkflowAgentStatus, WorkflowRun, WorkflowStatus } from "../../types/messages"

/** Agents the expanded card lists at most; the phase rows still count every agent. */
export const WORKFLOW_AGENT_LIMIT = 200

export function workflowTerminal(status: WorkflowStatus | undefined) {
  return status === "completed" || status === "error" || status === "stopped"
}

/** Stop while running or paused, pause while running, resume while paused; nothing for a read-only transcript. */
export function workflowActions(status: WorkflowStatus | undefined, readonly?: boolean) {
  if (readonly || !status) return { stop: false, pause: false, resume: false }
  return {
    stop: status === "running" || status === "paused",
    pause: status === "running",
    resume: status === "paused",
  }
}

/** Compact, locale-aware token count such as "12.3K". */
export function workflowTokens(count: number, locale?: string) {
  return new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 1 }).format(count)
}

const ORDER: Record<WorkflowAgentStatus, number> = {
  running: 0,
  error: 1,
  queued: 2,
  completed: 3,
  cached: 3,
  skipped: 3,
}

/** Running and failed agents first, then the rest in start order, capped so a 1000-agent run stays cheap. */
export function workflowAgents(list: WorkflowAgent[]) {
  return [...list].sort((a, b) => ORDER[a.status] - ORDER[b.status] || a.index - b.index).slice(0, WORKFLOW_AGENT_LIMIT)
}

/**
 * Changes whenever the agent list can have changed (an agent started, finished
 * or failed, or the run changed status). Token-only updates keep the same key,
 * so a streaming run does not refetch its detail several times a second.
 */
export function workflowKey(run: WorkflowRun | undefined) {
  if (!run) return ""
  return [run.status, run.agents, run.running, run.done, run.error, run.skipped].join(":")
}
