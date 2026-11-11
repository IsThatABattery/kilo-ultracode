import { describe, expect, it } from "bun:test"
import type { KiloClient, Session, WorkflowRunDetail as Detail, WorkflowRunInfo as Info } from "@kilocode/sdk/v2/client"
import { serverFeatures } from "../../src/features"
import { mapSSEEventToWebviewMessage, sessionToWebview } from "../../src/kilo-provider-utils"
import { routeWorkflowMessage } from "../../src/kilo-provider/workflow"
import { toDetail, toRun, workflowAgent } from "../../src/kilo-provider/workflow-run"
import { flag, ultracodeField } from "../../src/kilo-provider/prompt-options"
import { resolveEventSessionId } from "../../src/services/cli-backend/connection-utils"
import type { SSEPayload } from "../../src/services/cli-backend/sdk-sse-adapter"

const info: Info = {
  id: "wf_1234abcd-abc",
  sessionID: "ses_parent",
  name: "review",
  description: "Review the diff",
  status: "running",
  phases: [{ title: "Find", total: 3, running: 1, done: 2, error: 0, skipped: 0 }],
  agents: 3,
  running: 1,
  done: 2,
  error: 0,
  skipped: 0,
  cached: 1,
  tokens: 1234,
  tools: 7,
  size: "medium",
  started: 1000,
  ended: "NaN",
  dir: "/data/workflow/ses_parent/wf_1234abcd-abc",
  script: "/data/workflow/ses_parent/wf_1234abcd-abc/script.js",
}

const detail: Detail = {
  ...info,
  logs: ["narrator"],
  result: "secret",
  list: [
    {
      id: "a1",
      index: 0,
      label: "find bugs",
      status: "running",
      sessionID: "ses_child",
      agentType: "workflow-subagent",
      tokens: 10,
      tools: 1,
      started: 1001,
      prompt: "long prompt",
    },
  ],
}

function session(metadata?: Record<string, unknown>): Session {
  return {
    id: "ses_parent",
    slug: "s",
    projectID: "p",
    directory: "/repo",
    title: "Session",
    version: "1",
    time: { created: 1, updated: 1 },
    ...(metadata ? { metadata } : {}),
  } as Session
}

function client(calls: unknown[][], fail?: string) {
  const reply =
    (name: string, data: unknown) =>
    async (...args: unknown[]) => {
      calls.push([name, ...args])
      if (fail === name) throw new Error(`${name} failed`)
      return { data }
    }
  return {
    workflow: {
      get: reply("get", detail),
      stop: reply("stop", { ...info, status: "stopped" }),
      pause: reply("pause", { ...info, status: "paused" }),
      resume: reply("resume", info),
      agentStop: reply("agentStop", true),
    },
    ultracode: { set: reply("set", { enabled: true }) },
  } as unknown as KiloClient
}

describe("workflow run shapes", () => {
  it("normalizes non-finite times and drops prompts, results and logs", () => {
    expect(toRun(info).ended).toBeUndefined()
    expect(toRun(info).started).toBe(1000)
    const value = toDetail(detail)
    expect(value.list[0]).toEqual({
      id: "a1",
      index: 0,
      label: "find bugs",
      phase: undefined,
      group: undefined,
      status: "running",
      sessionID: "ses_child",
      model: undefined,
      tokens: 10,
      tools: 1,
      started: 1001,
      ended: undefined,
      error: undefined,
    })
    expect(JSON.stringify(value)).not.toContain("secret")
    expect(JSON.stringify(value)).not.toContain("long prompt")
  })

  it("adopts only workflow agent sessions of a tracked session", () => {
    const tracked = (id: string) => id === "ses_parent"
    expect(workflowAgent({ parentID: "ses_parent", metadata: { "kilo.workflow": { runID: "wf" } } }, tracked)).toBe(
      true,
    )
    expect(workflowAgent({ parentID: "ses_parent" }, tracked)).toBe(false)
    expect(workflowAgent({ parentID: "ses_other", metadata: { "kilo.workflow": {} } }, tracked)).toBe(false)
    expect(workflowAgent({ metadata: { "kilo.workflow": {} } }, tracked)).toBe(false)
  })
})

describe("workflow events", () => {
  const event = { id: "evt_1", type: "workflow.run.updated", properties: { run: info } } as const

  it("routes a run update to the launching session", () => {
    expect(resolveEventSessionId(event as unknown as SSEPayload, () => undefined)).toBe("ses_parent")
  })

  it("maps a run update to a webview message", () => {
    expect(mapSSEEventToWebviewMessage(event as never, "ses_parent")).toEqual({
      type: "workflowRunUpdated",
      run: toRun(info),
    })
  })
})

describe("ultracode session state", () => {
  it("projects a stored toggle and omits an unset one", () => {
    expect(sessionToWebview(session({ "kilo.ultracode": { enabled: true } })).ultracode).toBe(true)
    expect(sessionToWebview(session({ "kilo.ultracode": { enabled: false } })).ultracode).toBe(false)
    expect(sessionToWebview(session())).not.toHaveProperty("ultracode")
    expect(sessionToWebview(session({ "kilo.ultracode": { enabled: "yes" } }))).not.toHaveProperty("ultracode")
  })

  it("sends only an explicit boolean choice with a prompt", () => {
    expect(ultracodeField(flag(true))).toEqual({ ultracode: true })
    expect(ultracodeField(flag(false))).toEqual({ ultracode: false })
    expect(ultracodeField(flag(undefined))).toEqual({})
    expect(ultracodeField(flag("true"))).toEqual({})
  })
})

describe("workflow webview requests", () => {
  const ctx = (calls: unknown[][], posted: unknown[], fail?: string) => ({
    client: client(calls, fail),
    dir: (sid: string) => `/dir/${sid}`,
    post: (message: unknown) => posted.push(message),
  })

  it("ignores unrelated messages", async () => {
    const calls: unknown[][] = []
    expect(await routeWorkflowMessage({ type: "sendMessage" }, ctx(calls, []))).toBe(false)
    expect(calls).toEqual([])
  })

  it("persists ultracode in the session's directory", async () => {
    const calls: unknown[][] = []
    const message = { type: "setUltracode", sessionID: "ses_parent", enabled: true }
    expect(await routeWorkflowMessage(message, ctx(calls, []))).toBe(true)
    expect(calls[0]?.[1]).toEqual({ sessionID: "ses_parent", enabled: true, directory: "/dir/ses_parent" })
  })

  it("loads a run's detail", async () => {
    const calls: unknown[][] = []
    const posted: unknown[] = []
    await routeWorkflowMessage(
      { type: "requestWorkflowRun", runID: info.id, sessionID: "ses_parent" },
      ctx(calls, posted),
    )
    expect(calls[0]?.[1]).toEqual({ runID: info.id, directory: "/dir/ses_parent" })
    expect(posted).toEqual([{ type: "workflowRunLoaded", runID: info.id, run: toDetail(detail) }])
  })

  it("reports a failed load without throwing", async () => {
    const posted: unknown[] = []
    await routeWorkflowMessage(
      { type: "requestWorkflowRun", runID: info.id, sessionID: "ses_parent" },
      ctx([], posted, "get"),
    )
    expect(posted).toEqual([{ type: "workflowRunLoaded", runID: info.id, error: "get failed" }])
  })

  it("pauses, resumes and stops a run and posts the new summary", async () => {
    const calls: unknown[][] = []
    const posted: unknown[] = []
    for (const action of ["pause", "resume", "stop"]) {
      await routeWorkflowMessage(
        { type: "workflowControl", action, runID: info.id, sessionID: "ses_parent" },
        ctx(calls, posted),
      )
    }
    expect(calls.map((call) => call[0])).toEqual(["pause", "resume", "stop"])
    expect(posted).toEqual([
      { type: "workflowRunUpdated", run: toRun({ ...info, status: "paused" }) },
      { type: "workflowRunUpdated", run: toRun(info) },
      { type: "workflowRunUpdated", run: toRun({ ...info, status: "stopped" }) },
    ])
  })

  it("stops one agent and reloads the agent list", async () => {
    const calls: unknown[][] = []
    const posted: unknown[] = []
    const message = { type: "workflowControl", action: "stop", runID: info.id, sessionID: "ses_parent", agentID: "a1" }
    await routeWorkflowMessage(message, ctx(calls, posted))
    expect(calls.map((call) => call[0])).toEqual(["agentStop", "get"])
    expect(calls[0]?.[1]).toEqual({ runID: info.id, agentID: "a1", directory: "/dir/ses_parent" })
    expect(posted).toEqual([{ type: "workflowRunLoaded", runID: info.id, run: toDetail(detail) }])
  })

  it("rejects unknown control actions", async () => {
    const calls: unknown[][] = []
    const message = { type: "workflowControl", action: "delete", runID: info.id, sessionID: "ses_parent" }
    expect(await routeWorkflowMessage(message, ctx(calls, []))).toBe(true)
    expect(calls).toEqual([])
  })
})

describe("server capabilities", () => {
  const backend = (data: unknown, fail = false) =>
    ({
      experimental: {
        capabilities: {
          get: async () => {
            if (fail) throw new Error("offline")
            return { data }
          },
        },
      },
    }) as unknown as Pick<KiloClient, "experimental">

  it("reads the workflows capability and treats an older backend as unavailable", async () => {
    expect(await serverFeatures(backend({ backgroundSubagents: true, workflows: true }), "/repo")).toEqual({
      backgroundSubagents: true,
      workflows: true,
    })
    expect(await serverFeatures(backend({ backgroundSubagents: true }), "/repo")).toEqual({
      backgroundSubagents: true,
      workflows: false,
    })
    expect(await serverFeatures(backend(undefined, true), "/repo")).toEqual({
      backgroundSubagents: false,
      workflows: false,
    })
  })
})
