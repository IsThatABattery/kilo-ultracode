export * as WorkflowEvent from "./workflow-event"

import { Schema } from "effect"
import { Event } from "../event"
import { NonNegativeInt } from "../schema"

export const Status = Schema.Literals(["running", "paused", "completed", "error", "stopped"])

export const AgentStatus = Schema.Literals(["queued", "running", "completed", "error", "skipped", "cached"])

export const Size = Schema.Literals(["small", "medium", "large", "unrestricted"])

/** One progress group of a run: a `meta.phases` entry, a `phase()` title, or a nested workflow's "▸ name" group. */
export const PhaseInfo = Schema.Struct({
  title: Schema.String,
  detail: Schema.optional(Schema.String),
  total: NonNegativeInt,
  running: NonNegativeInt,
  done: NonNegativeInt,
  error: NonNegativeInt,
  skipped: NonNegativeInt,
}).annotate({ identifier: "WorkflowPhaseInfo" })

/** Run summary shown by lists, the TUI and VS Code. */
export const RunInfo = Schema.Struct({
  id: Schema.String,
  sessionID: Schema.String,
  name: Schema.String,
  description: Schema.String,
  status: Status,
  phases: Schema.Array(PhaseInfo),
  agents: NonNegativeInt,
  running: NonNegativeInt,
  done: NonNegativeInt,
  error: NonNegativeInt,
  skipped: NonNegativeInt,
  cached: NonNegativeInt,
  tokens: NonNegativeInt,
  tools: NonNegativeInt,
  size: Size,
  /** Epoch milliseconds. */
  started: Schema.Finite,
  ended: Schema.optional(Schema.Finite),
  dir: Schema.String,
  script: Schema.String,
  error_message: Schema.optional(Schema.String),
}).annotate({ identifier: "WorkflowRunInfo" })

export const Worktree = Schema.Struct({
  path: Schema.String,
  branch: Schema.optional(Schema.String),
  changed: Schema.Boolean,
}).annotate({ identifier: "WorkflowWorktree" })

export const AgentInfo = Schema.Struct({
  id: Schema.String,
  index: NonNegativeInt,
  label: Schema.String,
  phase: Schema.optional(Schema.String),
  group: Schema.optional(Schema.String),
  status: AgentStatus,
  sessionID: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  variant: Schema.optional(Schema.String),
  agentType: Schema.String,
  tokens: NonNegativeInt,
  tools: NonNegativeInt,
  /** Epoch milliseconds. */
  started: Schema.optional(Schema.Finite),
  ended: Schema.optional(Schema.Finite),
  prompt: Schema.String,
  result: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
  worktree: Schema.optional(Worktree),
}).annotate({ identifier: "WorkflowAgentInfo" })

/** Full run state: the summary plus narrator logs, every agent, and the serialized result. */
export const RunDetail = Schema.Struct({
  ...RunInfo.fields,
  logs: Schema.Array(Schema.String),
  list: Schema.Array(AgentInfo),
  result: Schema.optional(Schema.String),
}).annotate({ identifier: "WorkflowRunDetail" })

/** A workflow run changed: status, counters, phases or tokens. Throttled while running; always sent on status change. */
export const Updated = Event.define({
  type: "workflow.run.updated",
  schema: { run: RunInfo },
})

export const Definitions = Event.inventory(Updated)
