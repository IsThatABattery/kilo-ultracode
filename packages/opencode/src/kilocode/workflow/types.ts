// Shared contracts for Kilo dynamic workflows (port of Claude Code's Workflow tool / ultracode).
// Every workflow module codes against these types; keep them JSON-serializable.

export type Effort = "low" | "medium" | "high" | "xhigh" | "max"

export type Size = "small" | "medium" | "large" | "unrestricted"

/** Options accepted by the script-level `agent(prompt, opts)` hook. */
export type AgentOpts = {
  label?: string
  phase?: string
  schema?: Record<string, unknown>
  model?: string
  effort?: string
  isolation?: "worktree"
  agentType?: string
}

export type Phase = { title: string; detail?: string; model?: string }

export type Meta = {
  name: string
  description: string
  whenToUse?: string
  phases: Phase[]
}

/** Reference accepted by the script-level `workflow(nameOrRef, args)` hook. */
export type Ref = string | { scriptPath: string }

/** A call from the sandboxed script to the host. */
export type Call =
  | { method: "agent"; prompt: string; opts: AgentOpts }
  | { method: "workflow"; ref: Ref; args?: unknown }
  | { method: "log"; message: string }
  | { method: "phase"; title: string }

export type Status = "running" | "paused" | "completed" | "error" | "stopped"

export type AgentStatus = "queued" | "running" | "completed" | "error" | "skipped" | "cached"

export type Tokens = { input: number; output: number; reasoning: number; total: number }

/** Worktree an isolation: 'worktree' agent ran in; kept (with a branch) only when it changed. */
export type WorktreeResult = { path: string; branch?: string; changed: boolean }

/** Outcome of one agent() call as produced by the spawn layer. */
export type Outcome =
  | {
      status: "completed"
      value: unknown
      sessionID: string
      tokens: Tokens
      tools: number
      model: { providerID: string; modelID: string }
      /** Variant actually applied (after mapping `effort`), if any. */
      variant?: string
      worktree?: WorktreeResult
      /** Non-fatal note, e.g. opts.model was unavailable and the inherited model ran instead. */
      warning?: string
    }
  | {
      status: "error"
      error: string
      /** true: terminal API/provider failure after retries → the script receives null. false: the agent() call throws. */
      terminal: boolean
      sessionID?: string
      tokens: Tokens
      tools: number
      worktree?: WorktreeResult
      warning?: string
    }
  | {
      status: "skipped"
      sessionID?: string
      tokens: Tokens
      tools: number
      worktree?: WorktreeResult
      warning?: string
    }

export type PhaseInfo = {
  title: string
  detail?: string
  total: number
  running: number
  done: number
  error: number
  skipped: number
}

/** Run summary: what lists, events and the TUI/VS Code row show. */
export type RunInfo = {
  id: string
  sessionID: string
  name: string
  description: string
  status: Status
  phases: PhaseInfo[]
  agents: number
  running: number
  done: number
  error: number
  skipped: number
  cached: number
  tokens: number
  tools: number
  size: Size
  started: number
  ended?: number
  dir: string
  script: string
  error_message?: string
}

export type AgentInfo = {
  id: string
  index: number
  label: string
  phase?: string
  group?: string
  status: AgentStatus
  sessionID?: string
  model?: string
  variant?: string
  agentType: string
  tokens: number
  tools: number
  started?: number
  ended?: number
  prompt: string
  result?: string
  error?: string
  worktree?: { path: string; branch?: string; changed: boolean }
}

export type RunDetail = RunInfo & {
  logs: string[]
  list: AgentInfo[]
  result?: string
}
