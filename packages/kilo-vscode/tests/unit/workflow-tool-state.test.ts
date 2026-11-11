import { describe, expect, it } from "bun:test"
import {
  WORKFLOW_AGENT_LIMIT,
  workflowActions,
  workflowAgents,
  workflowKey,
  workflowLarge,
  workflowLatest,
  workflowReload,
  workflowTerminal,
  workflowTokens,
} from "../../webview-ui/src/components/chat/workflow-tool-state"
import type { ToolPart, WorkflowAgent, WorkflowRun } from "../../webview-ui/src/types/messages"

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
  size: "medium",
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

  it("reloads a large run's agent list less often", () => {
    expect(workflowReload(undefined)).toBe(1000)
    expect(workflowReload({ ...run, agents: 40 })).toBe(1000)
    expect(workflowReload({ ...run, agents: 1000 })).toBe(10_000)
  })

  it("warns about a run past 25 agents or 1.5M projected tokens, as Claude Code does", () => {
    const off = { ultracode: false }
    expect(workflowLarge({ ...run, agents: 25 }, off)).toBe(false)
    expect(workflowLarge({ ...run, agents: 26 }, off)).toBe(true)
    // 2 of 20 agents ran on 200K tokens: 2M projected.
    expect(workflowLarge({ ...run, agents: 20, done: 2, error: 0, tokens: 200_000 }, off)).toBe(true)
    expect(workflowLarge({ ...run, agents: 20, done: 2, error: 0, tokens: 100_000 }, off)).toBe(false)
    // Cached replays spent nothing, so they neither lower nor raise the projection.
    // 2 of the 10 agents that run spent 320K: 1.6M projected (a naive 320K / 12 * 20 is only 533K).
    expect(workflowLarge({ ...run, agents: 20, done: 12, cached: 10, error: 0, tokens: 320_000 }, off)).toBe(true)
    expect(workflowLarge({ ...run, agents: 3, done: 0, error: 0, tokens: 1_600_000 }, off)).toBe(true)
    expect(workflowLarge(undefined, off)).toBe(false)
  })

  it("uses a chosen size guideline's agent count and stays quiet with ultracode or once the run ends", () => {
    expect(workflowLarge({ ...run, agents: 6 }, { ultracode: false, size: "small" })).toBe(true)
    expect(workflowLarge({ ...run, agents: 40 }, { ultracode: false, size: "large" })).toBe(false)
    expect(workflowLarge({ ...run, agents: 60 }, { ultracode: false, size: "large" })).toBe(true)
    expect(workflowLarge({ ...run, agents: 26 }, { ultracode: false, size: "unrestricted" })).toBe(true)
    expect(workflowLarge({ ...run, agents: 100 }, { ultracode: true })).toBe(false)
    expect(workflowLarge({ ...run, agents: 100, status: "completed" }, { ultracode: false })).toBe(false)
    expect(workflowLarge({ ...run, agents: 100, status: "paused" }, { ultracode: false })).toBe(true)
  })

  it("opens the latest workflow run of the session", () => {
    const part = (id: string, tool: string, runID?: string): ToolPart => ({
      id,
      messageID: `msg_${id}`,
      type: "tool",
      tool,
      state: { status: "completed", input: {}, output: "", title: "", metadata: runID ? { runID } : {} },
    })
    const parts = [
      part("p1", "workflow", "wf_1"),
      part("p2", "workflow", "wf_2"),
      part("p3", "bash"),
      part("p4", "workflow"),
    ]
    expect(workflowLatest(parts)?.id).toBe("p2")
    expect(workflowLatest([part("p3", "bash")])).toBeUndefined()
    expect(workflowLatest([{ ...part("p5", "workflow", "wf_5"), messageID: undefined }])).toBeUndefined()
  })
})
