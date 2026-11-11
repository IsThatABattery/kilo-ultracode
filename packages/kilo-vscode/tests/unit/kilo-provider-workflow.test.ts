import { afterEach, describe, expect, it } from "bun:test"
import * as vscode from "vscode"
import type { Event, Session, WorkflowRunInfo } from "@kilocode/sdk/v2/client"

// vscode mock is provided by the shared preload (tests/setup/vscode-mock.ts)
const { KiloProvider } = await import("../../src/KiloProvider")
const { resolveEventSessionId } = await import("../../src/services/cli-backend/connection-utils")

type Receive = (message: unknown) => Promise<void>

type Internals = {
  webview: { postMessage: (message: unknown) => Promise<unknown> } | null
  trackedSessionIds: Set<string>
  syncedChildSessions: Set<string>
  sessionDirectories: Map<string, string>
  sessionGitDirectories: Map<string, string>
  currentSession: Session | null
  initializeConnection: () => Promise<void>
  setupWebviewMessageHandler: (webview: { onDidReceiveMessage: (handler: Receive) => { dispose: () => void } }) => void
  handleSyncSession: (sessionID: string, parentSessionID?: string) => Promise<void>
  releaseChildSession: (sessionID: string) => void
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

type Options = ConstructorParameters<typeof KiloProvider>[3]

const commands = (vscode as unknown as { commands: { executeCommand: (...args: unknown[]) => Promise<unknown> } })
  .commands
const execute = commands.executeCommand

afterEach(() => {
  commands.executeCommand = execute
})

function connection(client: object = {}) {
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
    getClient: () => client as never,
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
    onSessionAcknowledged: () => () => undefined,
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
    // No prompt was seen on this connection, so replies fall back to the session's directory.
    getPermissionDirectory: () => undefined,
    getPermissionSession: () => undefined,
    isPermissionResponseClaimed: () => false,
    runPermissionResponse: (_id: string, _sid: string, action: () => Promise<unknown>) => action(),
    clearPermissionDirectory: () => undefined,
    clearPermissionResponse: () => undefined,
    getQuestionDirectory: () => undefined,
    clearQuestionDirectory: () => undefined,
    runExplicitAbort: (_sid: string, _dir: string, action: () => Promise<unknown>) => action(),
  }
}

/** The launching session's Agent Manager worktree. */
const home = "/repo/worktree"
/** A workflow agent's own worktree under the Kilo data directory (isolation: 'worktree'). */
const tree = "/data/worktree/project-1/wf_1234abcd-abc-0"
const flow = { "kilo.workflow": { runID: "wf_1234abcd-abc", index: 0 } }

function info(id: string, parentID: string, directory: string, metadata?: Record<string, unknown>): Session {
  return {
    id,
    slug: `${id}-slug`,
    projectID: "project-1",
    directory,
    title: "find bugs (@workflow-subagent subagent)",
    version: "1",
    time: { created: 1, updated: 1 },
    parentID,
    ...(metadata ? { metadata } : {}),
  }
}

function created(id: string, parentID: string, metadata?: Record<string, unknown>, directory = "/repo"): Event {
  return {
    type: "session.created",
    properties: { sessionID: id, info: info(id, parentID, directory, metadata) },
  } as Event
}

function message(sessionID: string): Event {
  return {
    type: "message.updated",
    properties: { sessionID, info: { id: `msg_${sessionID}`, sessionID, role: "user", time: { created: 1 } } },
  } as Event
}

function part(sessionID: string, value: Record<string, unknown>): Event {
  return {
    type: "message.part.updated",
    properties: {
      sessionID,
      part: { id: `prt_${String(value.type)}`, sessionID, messageID: `msg_${sessionID}`, ...value },
      time: 1,
    },
  } as Event
}

function permission(sessionID: string, id = "per-1"): Event {
  return {
    id: `evt_${id}`,
    type: "permission.asked",
    properties: { id, sessionID, permission: "bash", patterns: [], always: [], metadata: {} },
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

async function setup(input: { opts?: Options; client?: object } = {}) {
  const service = connection(input.client)
  const provider = new KiloProvider({} as never, service as never, undefined, {
    rootDirectory: () => "/repo",
    ...input.opts,
  })
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
  internal.sessionDirectories.set("ses_parent", home)
  internal.sessionGitDirectories.set("ses_parent", "/repo")
  const listener = Promise.withResolvers<Receive>()
  internal.setupWebviewMessageHandler({
    onDidReceiveMessage: (handler) => {
      listener.resolve(handler)
      return { dispose: () => {} }
    },
  })
  return { service, internal, sent, receive: await listener.promise }
}

/** An Agent Manager panel: directory-gated to the active project's root and worktrees. */
function manager(dirs = [home]): Options {
  return { projectQualifier: () => ({ projectId: "project-1" }), worktreeDirectories: () => dirs }
}

describe("KiloProvider workflow sessions", () => {
  it("tracks a workflow agent session of a tracked session so its prompts reach the chat", async () => {
    const state = await setup()
    // Without isolation the agent runs in its launching session's instance and directory.
    state.service.emit(created("ses_agent", "ses_parent", flow, home), home)
    expect(state.internal.trackedSessionIds.has("ses_agent")).toBe(true)
    expect(state.internal.sessionDirectories.get("ses_agent")).toBe(home)
    expect(state.internal.sessionGitDirectories.get("ses_agent")).toBe("/repo")
    expect(state.sent.filter((message) => message.type === "sessionUpdated")).toHaveLength(1)
    // Recorded as a child only: it must never become the open session.
    expect(state.internal.currentSession).toBeNull()
    expect(state.sent.some((message) => message.type === "sessionCreated")).toBe(false)
  })

  it("keeps a sidebar agent in the workspace root without a directory override", async () => {
    const state = await setup()
    state.internal.trackedSessionIds.add("ses_root")
    state.service.emit(created("ses_agent", "ses_root", flow, "/repo"), "/repo")
    expect(state.internal.trackedSessionIds.has("ses_agent")).toBe(true)
    expect(state.internal.sessionDirectories.has("ses_agent")).toBe(false)
  })

  it("leaves other child sessions and untracked runs alone", async () => {
    const state = await setup()
    state.service.emit(created("ses_task", "ses_parent"), "/repo")
    state.service.emit(created("ses_foreign", "ses_other", { "kilo.workflow": { runID: "wf" } }), "/repo")
    expect(state.internal.trackedSessionIds.has("ses_task")).toBe(false)
    expect(state.internal.trackedSessionIds.has("ses_foreign")).toBe(false)
  })

  it("follows a worktree-isolated agent into its own worktree", async () => {
    const state = await setup({ opts: manager() })
    state.service.emit(created("ses_agent", "ses_parent", flow, tree), tree)
    expect(state.internal.trackedSessionIds.has("ses_agent")).toBe(true)
    expect(state.internal.sessionDirectories.get("ses_agent")).toBe(tree)
    // A worktree is its own checkout: the parent's Git root does not carry over.
    expect(state.internal.sessionGitDirectories.has("ses_agent")).toBe(false)

    state.sent.length = 0
    const events = [
      permission("ses_agent"),
      { type: "question.asked", properties: { id: "que-1", sessionID: "ses_agent", questions: [] } },
      { type: "session.status", properties: { sessionID: "ses_agent", status: { type: "busy" } } },
      message("ses_agent"),
    ]
    for (const event of events) state.service.emit(event as Event, tree)
    // Nobody views the agent yet, so its transcript stays on the backend.
    expect(state.sent.map((message) => message.type)).toEqual(["permissionRequest", "questionRequest", "sessionStatus"])
    // Opened in an inspector tab, its transcript streams from its worktree.
    state.internal.syncedChildSessions.add("ses_agent")
    state.service.emit(message("ses_agent"), tree)
    expect(state.sent.map((message) => message.type).at(-1)).toBe("messageCreated")

    // Other sessions in that worktree and the agent's events from other directories stay filtered.
    state.service.emit(permission("ses_other", "per-2"), tree)
    state.service.emit(message("ses_other"), tree)
    state.service.emit(message("ses_agent"), "/elsewhere")
    expect(state.sent).toHaveLength(4)
  })

  it("gates a worktree agent's transcript with its launching session's project", async () => {
    const dirs = [home]
    const state = await setup({ opts: manager(dirs) })
    state.service.emit(created("ses_agent", "ses_parent", flow, tree), tree)
    state.internal.syncedChildSessions.add("ses_agent")
    // The parent's project goes inactive: transcript events stop, activity events still pass.
    dirs.length = 0
    state.sent.length = 0
    state.service.emit(message("ses_agent"), tree)
    state.service.emit(permission("ses_agent"), tree)
    expect(state.sent.map((message) => message.type)).toEqual(["permissionRequest"])
  })

  it("replies to a worktree agent's prompts in its own worktree", async () => {
    const calls: Array<[string, string | undefined]> = []
    const client = {
      permission: {
        reply: async (params: { directory?: string }) => {
          calls.push(["permission", params.directory])
          return { data: true }
        },
      },
      question: {
        reply: async (params: { directory?: string }) => {
          calls.push(["question", params.directory])
          return { data: true }
        },
      },
      session: {
        abort: async (params: { sessionID: string; directory?: string }) => {
          calls.push([`abort ${params.sessionID}`, params.directory])
          return { data: true }
        },
      },
    }
    const state = await setup({ client })
    state.service.emit(created("ses_agent", "ses_parent", flow, tree), tree)

    await state.receive({
      type: "permissionResponse",
      permissionId: "per-1",
      sessionID: "ses_agent",
      response: "once",
      approvedAlways: [],
      deniedAlways: [],
    })
    await state.receive({ type: "questionReply", requestID: "que-1", answers: [["yes"]], sessionID: "ses_agent" })
    await state.receive({ type: "abort", sessionID: "ses_agent" })
    await state.receive({ type: "abort", sessionID: "ses_parent" })

    expect(calls).toEqual([
      ["permission", tree],
      ["question", tree],
      ["abort ses_agent", tree],
      ["abort ses_parent", home],
    ])
  })

  it("keeps a released agent tracked, so a prompt it asks after its tab closes still shows", async () => {
    const dirs: Array<string | undefined> = []
    const client = {
      session: {
        get: async (params: { directory?: string }) => {
          dirs.push(params.directory)
          return { data: info("ses_agent", "ses_parent", tree, flow) }
        },
        messages: async (params: { directory?: string }) => {
          dirs.push(params.directory)
          return { data: [] }
        },
      },
    }
    const state = await setup({ opts: manager(), client })
    state.service.emit(created("ses_agent", "ses_parent", flow, tree), tree)
    await state.internal.handleSyncSession("ses_agent", "ses_parent")
    // The inspector tab closes while the agent still runs.
    state.internal.releaseChildSession("ses_agent")
    expect(state.internal.syncedChildSessions.has("ses_agent")).toBe(false)
    expect(state.internal.trackedSessionIds.has("ses_agent")).toBe(true)
    expect(state.internal.sessionDirectories.get("ses_agent")).toBe(tree)
    state.sent.length = 0
    state.service.emit(permission("ses_agent"), tree)
    state.service.emit(
      { type: "question.asked", properties: { id: "que-1", sessionID: "ses_agent", questions: [] } } as Event,
      tree,
    )
    state.service.emit(message("ses_agent"), tree)
    expect(state.sent.map((message) => message.type)).toEqual(["permissionRequest", "questionRequest"])

    // Opened again, it reloads from its own worktree.
    await state.internal.handleSyncSession("ses_agent", "ses_parent")
    expect(state.internal.sessionDirectories.get("ses_agent")).toBe(tree)
    expect(dirs).toEqual([tree, tree, tree, tree])
  })

  it("streams only the parts of an unviewed agent that matter outside its transcript", async () => {
    const state = await setup()
    const synced: Array<[string, string | undefined]> = []
    state.internal.handleSyncSession = async (sessionID, parentSessionID) => {
      synced.push([sessionID, parentSessionID])
    }
    state.service.emit(created("ses_agent", "ses_parent", flow, home), home)
    state.sent.length = 0
    state.service.emit(message("ses_agent"), home)
    state.service.emit(part("ses_agent", { type: "text", text: "thinking out loud" }), home)
    state.service.emit(
      { type: "session.updated", source: "sync", properties: { sessionID: "ses_agent", info: {} } } as unknown as Event,
      home,
    )
    expect(state.sent).toEqual([])

    // A finished step refreshes model usage; a nested task child gets tracked for its own prompts.
    state.service.emit(part("ses_agent", { type: "step-finish", tokens: {} }), home)
    state.service.emit(
      part("ses_agent", {
        type: "tool",
        tool: "task",
        state: { status: "running", metadata: { sessionId: "ses_nested" } },
      }),
      home,
    )
    expect(state.sent).toEqual([{ type: "sessionModelUsageChanged", sessionID: "ses_agent" }])
    expect(synced).toEqual([["ses_nested", "ses_agent"]])
  })

  it("forgets a deleted agent", async () => {
    const state = await setup()
    state.service.emit(created("ses_agent", "ses_parent", flow, home), home)
    state.service.emit(
      {
        type: "session.deleted",
        properties: { sessionID: "ses_agent", info: info("ses_agent", "ses_parent", home, flow) },
      } as Event,
      home,
    )
    expect(state.internal.trackedSessionIds.has("ses_agent")).toBe(false)
    state.sent.length = 0
    state.service.emit(permission("ses_agent"), home)
    expect(state.sent).toEqual([])
  })

  it("opens a worktree agent's viewer in its own worktree", async () => {
    const executed: unknown[][] = []
    commands.executeCommand = async (...args: unknown[]) => {
      executed.push(args)
    }
    const state = await setup()
    state.service.emit(created("ses_agent", "ses_parent", flow, tree), tree)
    state.service.emit(created("ses_shared", "ses_parent", flow, home), home)
    const open = (sessionID: string) =>
      state.receive({ type: "openSubAgentViewer", sessionID, title: "find bugs", parentSessionID: "ses_parent" })
    await open("ses_agent")
    await open("ses_shared")
    expect(executed).toEqual([
      ["kilo-code.new.openSubAgentViewer", "ses_agent", "find bugs", tree],
      ["kilo-code.new.openSubAgentViewer", "ses_shared", "find bugs", home],
    ])
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
