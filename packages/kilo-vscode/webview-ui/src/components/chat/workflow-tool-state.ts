/**
 * Pure helpers for the workflow tool card: which controls a run offers, how its
 * agents are listed, when the card should reload the agent list, whether the run
 * counts as large, and which run `/workflows` opens.
 */

import type {
  ToolPart,
  WorkflowAgent,
  WorkflowAgentStatus,
  WorkflowRun,
  WorkflowSize,
  WorkflowStatus,
} from "../../types/messages"

/** Agents the expanded card lists at most; the phase rows still count every agent. */
export const WORKFLOW_AGENT_LIMIT = 200

/** Shortest wait between two agent-list reloads of an open card. */
const RELOAD = 1000

/** Claude Code's `Large workflow` thresholds: scheduled agents, then projected tokens. */
const LARGE_AGENTS = 25
const LARGE_TOKENS = 1_500_000
/** Agent count each size guideline aims below (KiloWorkflowEnabled.LIMITS in the CLI). */
const LIMITS: Partial<Record<WorkflowSize, number>> = { small: 5, medium: 10, large: 50 }

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

/**
 * Wait between agent-list reloads of an open card. Each reload fetches the whole run, so a run with
 * many agents reloads less often: 1s up to 100 agents, 10s at the 1000-agent cap.
 */
export function workflowReload(run: WorkflowRun | undefined) {
  return Math.max(RELOAD, (run?.agents ?? 0) * 10)
}

/**
 * Whether a live run shows Claude Code's `Large workflow` warning: more than 25 agents scheduled (or
 * the agent count of a size guideline the user chose), or more than 1.5M projected tokens. Ultracode
 * already opts into large runs, so it never shows there.
 */
export function workflowLarge(run: WorkflowRun | undefined, opts: { ultracode: boolean; size?: WorkflowSize }) {
  if (!run || opts.ultracode || workflowTerminal(run.status)) return false
  const limit = (opts.size && LIMITS[opts.size]) || LARGE_AGENTS
  if (run.agents > limit) return true
  // Agents replayed from a resumed run's cache spend nothing, so project from the ones that ran.
  const ran = run.done - run.cached + run.error
  const projected = ran > 0 ? (run.tokens / ran) * (run.agents - run.cached) : run.tokens
  return projected > LARGE_TOKENS
}

/** The workflow run `/workflows` opens: the latest launched in the session, like Claude Code with one run. */
export function workflowLatest(parts: readonly ToolPart[]) {
  return parts.findLast(
    (part) =>
      part.tool === "workflow" &&
      !!part.messageID &&
      "metadata" in part.state &&
      typeof part.state.metadata?.runID === "string",
  )
}
