import { describe, expect, it } from "bun:test"
import {
  WORKFLOW_AGENT_LIMIT,
  workflowActions,
  workflowAgents,
  workflowKey,
  workflowTerminal,
  workflowTokens,
} from "../../webview-ui/src/components/chat/workflow-tool-state"
import type { WorkflowAgent, WorkflowRun } from "../../webview-ui/src/types/messages"

const run: WorkflowRun = {
  id: "wf_1",
  sessionID: "ses_1",
  name: "review",
  description: "Review",
  status: "running",
  phases: [],
  agents: 4,
  running: 2,
  done: 1,
  error: 1,
  skipped: 0,
  cached: 0,
  tokens: 100,
  tools: 3,
  started: 1,
  dir: "/tmp/wf_1",
}

function agent(index: number, status: WorkflowAgent["status"]): WorkflowAgent {
  return { id: `a${index}`, index, label: `agent ${index}`, status, tokens: 0, tools: 0 }
}

describe("workflow tool state", () => {
  it("knows which statuses are final", () => {
    expect(workflowTerminal("running")).toBe(false)
    expect(workflowTerminal("paused")).toBe(false)
    expect(workflowTerminal("completed")).toBe(true)
    expect(workflowTerminal("error")).toBe(true)
    expect(workflowTerminal("stopped")).toBe(true)
    expect(workflowTerminal(undefined)).toBe(false)
  })

  it("offers pause and stop while running, resume and stop while paused, nothing once final or read-only", () => {
    expect(workflowActions("running")).toEqual({ stop: true, pause: true, resume: false })
    expect(workflowActions("paused")).toEqual({ stop: true, pause: false, resume: true })
    expect(workflowActions("completed")).toEqual({ stop: false, pause: false, resume: false })
    expect(workflowActions("running", true)).toEqual({ stop: false, pause: false, resume: false })
    expect(workflowActions(undefined)).toEqual({ stop: false, pause: false, resume: false })
  })

  it("formats token counts compactly", () => {
    expect(workflowTokens(950, "en")).toBe("950")
    expect(workflowTokens(12_300, "en")).toBe("12.3K")
    expect(workflowTokens(4_000_000, "en")).toBe("4M")
  })

  it("lists running and failed agents first, then the rest in start order", () => {
    const list = [agent(0, "completed"), agent(1, "error"), agent(2, "running"), agent(3, "queued"), agent(4, "cached")]
    expect(workflowAgents(list).map((item) => item.index)).toEqual([2, 1, 3, 0, 4])
  })

  it("caps the listed agents", () => {
    const list = Array.from({ length: WORKFLOW_AGENT_LIMIT + 5 }, (_, index) => agent(index, "completed"))
    expect(workflowAgents(list)).toHaveLength(WORKFLOW_AGENT_LIMIT)
  })

  it("only changes the reload key when agents start, finish or fail", () => {
    const key = workflowKey(run)
    expect(workflowKey({ ...run, tokens: 5000, tools: 9 })).toBe(key)
    expect(workflowKey({ ...run, done: 2, running: 1 })).not.toBe(key)
    expect(workflowKey({ ...run, status: "paused" })).not.toBe(key)
    expect(workflowKey(undefined)).toBe("")
  })
})
