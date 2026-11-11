/**
 * Dynamic workflow runs (the `workflow` tool) and ultracode, as the webview sees them.
 * Mirrors the backend's WorkflowRunInfo / WorkflowRunDetail with plain numbers.
 */

export type WorkflowStatus = "running" | "paused" | "completed" | "error" | "stopped"

export type WorkflowAgentStatus = "queued" | "running" | "completed" | "error" | "skipped" | "cached"

/** Size guideline in force when the run launched (`experimental.workflow_size`, default medium). */
export type WorkflowSize = "small" | "medium" | "large" | "unrestricted"

export interface WorkflowPhase {
  title: string
  detail?: string
  total: number
  running: number
  done: number
  error: number
  skipped: number
}

export interface WorkflowRun {
  id: string
  sessionID: string
  name: string
  description: string
  status: WorkflowStatus
  phases: WorkflowPhase[]
  agents: number
  running: number
  done: number
  error: number
  skipped: number
  cached: number
  tokens: number
  tools: number
  size: WorkflowSize
  started: number
  ended?: number
  dir: string
  error_message?: string
}

export interface WorkflowAgent {
  id: string
  index: number
  label: string
  phase?: string
  group?: string
  status: WorkflowAgentStatus
  sessionID?: string
  model?: string
  tokens: number
  tools: number
  started?: number
  ended?: number
  error?: string
}

export interface WorkflowRunDetail extends WorkflowRun {
  list: WorkflowAgent[]
}

// Webview → extension

export interface SetUltracodeRequest {
  type: "setUltracode"
  sessionID: string
  enabled: boolean
}

export interface RequestWorkflowRunMessage {
  type: "requestWorkflowRun"
  runID: string
  /** The session that launched the run; it picks the backend directory. */
  sessionID: string
}

export interface WorkflowControlRequest {
  type: "workflowControl"
  action: "stop" | "pause" | "resume"
  runID: string
  sessionID: string
  /** Stop only this agent of the run (action "stop"). */
  agentID?: string
}

// Extension → webview

/** Live summary from the backend's `workflow.run.updated` event or a control action. */
export interface WorkflowRunUpdatedMessage {
  type: "workflowRunUpdated"
  run: WorkflowRun
}

export interface WorkflowRunLoadedMessage {
  type: "workflowRunLoaded"
  runID: string
  run?: WorkflowRunDetail
  error?: string
}

/** A setUltracode request finished; once the last one is stored, the session's stored value takes over. */
export interface UltracodeSavedMessage {
  type: "ultracodeSaved"
  sessionID: string
  /** False when the backend did not store it (an error, or no connection). */
  ok: boolean
}
