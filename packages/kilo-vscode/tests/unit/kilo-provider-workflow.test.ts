import { describe, expect, it } from "bun:test"
import type { Event, Session, WorkflowRunInfo } from "@kilocode/sdk/v2/client"

// vscode mock is provided by the shared preload (tests/setup/vscode-mock.ts)
const { KiloProvider } = await import("../../src/KiloProvider")
const { resolveEventSessionId } = await import("../../src/services/cli-backend/connection-utils")

type Internals = {
  webview: { postMessage: (message: unknown) => Promise<unknown> } | null
  trackedSessionIds: Set<string>
  sessionDirectories: Map<string, string>
  currentSession: Session | null
  initializeConnection: () => Promise<void>
  syncWebviewState: () => Promise<void>
  flushPendingSessionRefresh: () => Promise<void>
  fetchAndSendProviders: () => Promise<void>
  fetchAndSendAgents: () => Promise<void>
  fetchAndSendSkills: () => Promise<void>
  fetchAndSendCommands: () => Promise<void>
  fetchAndSendConfig: () => Promise<void>
  fetchAndSendNotifications: () => Promise<void>
  seedSessionStatusMap: () => Promise<void>
  sendNotificationSettings: () => void
  startStatsPolling: () => void
}

function connection() {
  const state = {
    filter: undefined as ((event: Event, directory?: string) => boolean) | undefined,
    listener: undefined as ((event: Event, directory?: string) => void) | undefined,
  }
  return {
    emit(event: Event, directory?: string) {
      if (!state.filter || !state.listener) throw new Error("expected SSE subscription")
      if (!state.filter(event, directory)) return
      state.listener(event, directory)
    },
    connect: async () => {},
    getClient: () => ({}) as never,
    onEventFiltered: (
      next: (event: Event, directory?: string) => boolean,
      cb: (event: Event, directory?: string) => void,
    ) => {
      state.filter = next
      state.listener = cb
      return () => undefined
    },
    onStateChange: () => () => undefined,
    onNotificationDismissed: () => () => undefined,
    onClearPendingPrompts: () => () => undefined,
    onLanguageChanged: () => () => undefined,
    onProfileChanged: () => () => undefined,
    onFavoritesChanged: () => () => undefined,
    onModelSelectorExpandedChanged: () => () => undefined,
    registerDirectoryProvider: () => () => undefined,
    unregisterVisible: () => undefined,
    unregisterAttached: () => undefined,
    getServerInfo: () => ({ port: 12345 }),
    getServerConfig: () => ({ baseUrl: "http://127.0.0.1:12345", password: "test" }),
    getConnectionState: () => "connected" as const,
    getConnectionError: () => null,
    resolveEventSessionId: (event: Event) => resolveEventSessionId(event as never, () => undefined),
    recordMessageSessionId: () => undefined,
    notifyNotificationDismissed: () => undefined,
    clearPermissionSession: () => undefined,
    pruneSession: () => undefined,
  }
}

function created(id: string, parentID: string, metadata?: Record<string, unknown>): Event {
  return {
    type: "session.created",
    properties: {
      sessionID: id,
      info: {
        id,
        slug: `${id}-slug`,
        projectID: "project-1",
        directory: "/repo",
        title: "find bugs (@workflow-subagent subagent)",
        version: "1",
        time: { created: 1, updated: 1 },
        parentID,
        ...(metadata ? { metadata } : {}),
      },
    },
  } as Event
}

const run: WorkflowRunInfo = {
  id: "wf_1234abcd-abc",
  sessionID: "ses_parent",
  name: "review",
  description: "Review the diff",
  status: "running",
  phases: [],
  agents: 1,
  running: 1,
  done: 0,
  error: 0,
  skipped: 0,
  cached: 0,
  tokens: 0,
  tools: 0,
  size: "medium",
  started: 1,
  dir: "/data/workflow/ses_parent/wf_1234abcd-abc",
  script: "/data/workflow/ses_parent/wf_1234abcd-abc/script.js",
}

async function setup() {
  const service = connection()
  const provider = new KiloProvider({} as never, service as never, undefined, { rootDirectory: () => "/repo" })
  const internal = provider as unknown as Internals
  const sent: Array<{ type?: string }> = []
  internal.webview = {
    postMessage: async (message: unknown) => {
      sent.push(message as { type?: string })
      return true
    },
  }
  internal.syncWebviewState = async () => {}
  internal.flushPendingSessionRefresh = async () => {}
  internal.fetchAndSendProviders = async () => {}
  internal.fetchAndSendAgents = async () => {}
  internal.fetchAndSendSkills = async () => {}
  internal.fetchAndSendCommands = async () => {}
  internal.fetchAndSendConfig = async () => {}
  internal.fetchAndSendNotifications = async () => {}
  internal.seedSessionStatusMap = async () => {}
  internal.sendNotificationSettings = () => {}
  internal.startStatsPolling = () => {}
  await internal.initializeConnection()
  internal.trackedSessionIds.add("ses_parent")
  internal.sessionDirectories.set("ses_parent", "/repo/worktree")
  return { service, internal, sent }
}

describe("KiloProvider workflow sessions", () => {
  it("tracks a workflow agent session of a tracked session so its prompts reach the chat", async () => {
    const state = await setup()
    state.service.emit(created("ses_agent", "ses_parent", { "kilo.workflow": { runID: run.id, index: 0 } }), "/repo")
    expect(state.internal.trackedSessionIds.has("ses_agent")).toBe(true)
    expect(state.internal.sessionDirectories.get("ses_agent")).toBe("/repo/worktree")
    expect(state.sent.filter((message) => message.type === "sessionUpdated")).toHaveLength(1)
    // Recorded as a child only: it must never become the open session.
    expect(state.internal.currentSession).toBeNull()
    expect(state.sent.some((message) => message.type === "sessionCreated")).toBe(false)
  })

  it("leaves other child sessions and untracked runs alone", async () => {
    const state = await setup()
    state.service.emit(created("ses_task", "ses_parent"), "/repo")
    state.service.emit(created("ses_foreign", "ses_other", { "kilo.workflow": { runID: "wf" } }), "/repo")
    expect(state.internal.trackedSessionIds.has("ses_task")).toBe(false)
    expect(state.internal.trackedSessionIds.has("ses_foreign")).toBe(false)
  })

  it("forwards run updates for tracked sessions only", async () => {
    const state = await setup()
    const update = (sessionID: string) =>
      ({ id: `evt_${sessionID}`, type: "workflow.run.updated", properties: { run: { ...run, sessionID } } }) as Event
    state.service.emit(update("ses_parent"), "/repo")
    state.service.emit(update("ses_other"), "/repo")
    const runs = state.sent.filter((message) => message.type === "workflowRunUpdated") as Array<{
      run: { sessionID: string }
    }>
    expect(runs.map((message) => message.run.sessionID)).toEqual(["ses_parent"])
  })
})
