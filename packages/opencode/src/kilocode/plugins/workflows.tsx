import type { PermissionRequest } from "@kilocode/sdk/v2"
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@kilocode/plugin/tui"
import { createEffect, createMemo, createSignal, For, on, onCleanup, Show, type Accessor } from "solid-js"
import { useSDK } from "@tui/context/sdk"
import { KiloInstance } from "@tui/kilocode/instance"
import { UltracodeKeyword } from "@tui/kilocode/ultracode-keyword"
import { KILO_BASE_MODE } from "@tui/keymap"
import {
  DialogWorkflowRun,
  DialogWorkflows,
  useNow,
  useWorkflowRuns,
} from "@/kilocode/cli/cmd/tui/component/dialog-workflows"
import { WorkflowView } from "@/kilocode/cli/cmd/tui/workflow-view"
import { MemoryPermissionRegistry } from "@/kilocode/cli/cmd/tui/routes/session/memory-permission"

const id = "internal:kilo-workflows"

/** Session metadata key the spawn layer sets on workflow agent sessions. */
const AGENT = "kilo.workflow"

/** Ultracode reminders go to root sessions only, so a child session's toggle and indicator act on its root. */
export function root(api: Pick<TuiPluginApi, "state">, sessionID: string) {
  return WorkflowView.root((id) => api.state.session.get(id)?.parentID, sessionID)
}

/** The `workflow` permission prompt: the script's meta name, description and phases, never the script itself. */
export function permission(request: Pick<PermissionRequest, "metadata" | "patterns">) {
  const meta = request.metadata
  const name = typeof meta.name === "string" && meta.name ? meta.name : request.patterns.at(0)
  const description = typeof meta.description === "string" && meta.description ? meta.description : undefined
  const phases = Array.isArray(meta.phases)
    ? meta.phases.flatMap((item: unknown) => {
        if (!item || typeof item !== "object") return []
        const title = (item as { title?: unknown }).title
        return typeof title === "string" && title ? [title] : []
      })
    : []
  return {
    title: name ? `Run workflow "${name}"` : "Run workflow",
    lines: [...(description ? [description] : []), ...(phases.length ? [`Phases: ${phases.join(" · ")}`] : [])],
  }
}

/**
 * The script a `workflow` permission would run, for "View raw script": the file it was read from (scriptPath or a
 * saved workflow), else the inline script of the pending tool call. The ask metadata never carries inline text.
 */
export function source(
  api: Pick<TuiPluginApi, "state">,
  request: Pick<PermissionRequest, "metadata" | "tool">,
): { file?: string; script?: string } {
  const file = request.metadata.script
  if (typeof file === "string" && file) return { file }
  const tool = request.tool
  if (!tool) return {}
  const part = api.state.part(tool.messageID).find((item) => item.type === "tool" && item.callID === tool.callID)
  const script = part?.type === "tool" ? part.state.input?.script : undefined
  return typeof script === "string" && script ? { script } : {}
}

/** Permission body: description and phases, then the script source, kept collapsed until `v` or a click opens it. */
function Permission(props: { api: TuiPluginApi; request: PermissionRequest; lines: string[] }) {
  const theme = () => props.api.theme.current
  const raw = createMemo(() => source(props.api, props.request))
  const [open, setOpen] = createSignal(false)
  const toggle = () => setOpen((value) => raw().script !== undefined && !value)
  onCleanup(
    props.api.keymap.registerLayer({
      mode: KILO_BASE_MODE,
      bindings: [{ key: "v", desc: "View raw workflow script", group: "Permission", cmd: toggle }],
    }),
  )
  return (
    <box paddingLeft={1} flexDirection="column" flexShrink={1}>
      <For each={props.lines}>
        {(line) => (
          <text fg={theme().textMuted} wrapMode="word">
            {line}
          </text>
        )}
      </For>
      <Show when={raw().file}>
        {(file) => (
          <text fg={theme().textMuted} wrapMode="word">
            Script: {file()}
          </text>
        )}
      </Show>
      <Show when={raw().script}>
        {(script) => (
          <>
            <box flexDirection="row" gap={1} onMouseUp={toggle}>
              <text fg={theme().text}>v</text>
              <text fg={theme().textMuted}>{open() ? "hide raw script" : "view raw script"}</text>
            </box>
            <Show when={open()}>
              <scrollbox flexShrink={1} flexGrow={1} minHeight={3} paddingTop={1}>
                <text fg={theme().text}>{script()}</text>
              </scrollbox>
            </Show>
          </>
        )}
      </Show>
    </box>
  )
}

/** Refetches workflow capabilities when the SSE stream (re)connects to a possibly restarted server. */
export function Reconnect(props: { refresh: () => Promise<void> }) {
  const sdk = useSDK()
  // `api.event` drops `server.connected`: it carries no directory or project, so read the raw stream.
  onCleanup(
    sdk.event.on("event", (event) => {
      if (event.payload.type === "server.connected") void props.refresh()
    }),
  )
  return null
}

function session(api: TuiPluginApi) {
  if (api.route.current.name !== "session") return
  const sessionID = api.route.current.params?.sessionID
  if (typeof sessionID !== "string") return
  return sessionID
}

async function ensureSession(api: TuiPluginApi) {
  const current = session(api)
  if (current) return current
  const result = await api.client.session.create({}, { throwOnError: true })
  const sessionID = result.data?.id
  if (sessionID) api.route.navigate("session", { sessionID })
  return sessionID
}

/** The session whose ultracode toggle is on screen, or the config default when none is. */
export function ultracode(api: Pick<TuiPluginApi, "state">, sessionID: string | undefined) {
  const fallback = api.state.config.experimental?.ultracode === true
  if (!sessionID) return fallback
  return WorkflowView.ultracode(api.state.session.get(sessionID)?.metadata, fallback)
}

/** Workflow agent child sessions show the runs of the session that launched them. */
export function owner(api: Pick<TuiPluginApi, "state">, sessionID: string) {
  const info = api.state.session.get(sessionID)
  if (info?.parentID && info.metadata?.[AGENT]) return info.parentID
  return sessionID
}

function Indicator(props: {
  api: TuiPluginApi
  sessionID: string
  available: Accessor<boolean>
  refresh: () => Promise<void>
}) {
  createEffect(
    on(
      () => props.api.state.config.experimental?.workflows,
      () => void props.refresh(),
      { defer: true },
    ),
  )
  const shown = createMemo(() => props.available() && ultracode(props.api, root(props.api, props.sessionID)))
  return (
    <box flexShrink={0}>
      <text fg={props.api.theme.current.accent}>{shown() ? "ultracode" : ""}</text>
    </box>
  )
}

function Sidebar(props: { api: TuiPluginApi; sessionID: string }) {
  const theme = () => props.api.theme.current
  const data = useWorkflowRuns(() => ({ sessionID: props.sessionID }))
  const list = createMemo(() => data.runs().filter((run) => WorkflowView.active(run.status)))
  const now = useNow(() => list().length > 0)
  const open = (runID: string) => props.api.ui.dialog.replace(() => <DialogWorkflowRun runID={runID} />)
  const large = (run: Parameters<typeof WorkflowView.large>[0] & { sessionID: string }) =>
    WorkflowView.large(run, {
      configured: props.api.state.config.experimental?.workflow_size,
      ultracode: ultracode(props.api, root(props.api, run.sessionID)),
    })

  return (
    <Show when={list().length > 0}>
      <box>
        <text fg={theme().text}>
          <b>Workflows</b>
        </text>
        <For each={list()}>
          {(run) => (
            <box onMouseUp={() => open(run.id)}>
              <text fg={theme().textMuted}>
                <span style={{ fg: WorkflowView.paint(theme(), WorkflowView.runTone(run.status)) }}>●</span> {run.name}
                {"  "}
                {WorkflowView.summary(run, now())}
              </text>
              <Show when={large(run)}>
                <text fg={theme().warning}>{WorkflowView.LARGE}</text>
              </Show>
            </box>
          )}
        </For>
      </box>
    </Show>
  )
}

const tui: TuiPlugin = async (api) => {
  const [available, setAvailable] = createSignal(false)
  const pending = new Set<string>()
  // Workflows can be off by config or KILO_DISABLE_WORKFLOWS; only the server knows, so ask its capabilities.
  const refresh = async () => {
    const result = await api.client.experimental.capabilities.get().catch(() => undefined)
    setAvailable(result?.data?.workflows === true)
  }
  // The server ignores the keyword when experimental.ultracode_keyword is off, so the prompt must not highlight it.
  UltracodeKeyword.report(() => available() && api.state.config.experimental?.ultracode_keyword !== false)
  void refresh()
  api.lifecycle.onDispose(() => UltracodeKeyword.report(false))
  // A reload of this directory's instance may follow a config change; worktree agents dispose other directories.
  api.lifecycle.onDispose(
    api.event.on("server.instance.disposed", (evt) => {
      if (KiloInstance.own(evt.properties.directory, api.state.path.directory)) void refresh()
    }),
  )

  MemoryPermissionRegistry.register("workflow", (request) => {
    const info = permission(request)
    return {
      icon: "◆",
      title: info.title,
      body: <Permission api={api} request={request} lines={info.lines} />,
    }
  })

  api.keymap.registerLayer({
    commands: [
      {
        namespace: "palette",
        name: "session.toggle.ultracode",
        get title() {
          const current = session(api)
          return ultracode(api, current ? root(api, current) : undefined) ? "Disable ultracode" : "Enable ultracode"
        },
        desc: "Plan a multi-agent workflow for every substantive task",
        category: "Kilo",
        slashName: "ultracode",
        get hidden() {
          return !available()
        },
        async run() {
          if (!available()) {
            api.ui.toast({ message: "Dynamic workflows are disabled", variant: "error", duration: 5000 })
            return
          }
          const current = await ensureSession(api).catch((err: unknown) => {
            api.ui.toast({ message: String(err), variant: "error", duration: 5000 })
            return undefined
          })
          if (!current) return
          const sessionID = root(api, current)
          if (pending.has(sessionID)) return
          pending.add(sessionID)
          const enabled = !ultracode(api, sessionID)
          const workspace = api.state.session.get(sessionID)?.workspaceID
          const result = await api.client.ultracode
            .set({ sessionID, enabled, workspace }, { throwOnError: true })
            .catch((err: unknown) => {
              api.ui.toast({ message: String(err), variant: "error", duration: 5000 })
              return undefined
            })
          pending.delete(sessionID)
          if (!result?.data) return
          api.ui.toast({ message: result.data.enabled ? "Ultracode on" : "Ultracode off", variant: "success" })
          api.ui.dialog.clear()
        },
      },
      {
        namespace: "palette",
        name: "workflow.list",
        title: "Workflows",
        desc: "Watch, stop, pause and save dynamic workflow runs",
        category: "Kilo",
        slashName: "workflows",
        get hidden() {
          return !available()
        },
        run() {
          const current = session(api)
          api.ui.dialog.replace(() => <DialogWorkflows sessionID={current ? owner(api, current) : undefined} />)
        },
      },
    ],
    bindings: [],
  })

  api.slots.register({
    order: 52,
    slots: {
      // A (re)connected server may have restarted with a different KILO_DISABLE_WORKFLOWS or config.
      app() {
        return <Reconnect refresh={refresh} />
      },
      session_prompt_right(_ctx, props) {
        return <Indicator api={api} sessionID={props.session_id} available={available} refresh={refresh} />
      },
    },
  })

  api.slots.register({
    order: 255,
    slots: {
      sidebar_content(_ctx, props) {
        return (
          <Show when={available()}>
            <Sidebar api={api} sessionID={owner(api, props.session_id)} />
          </Show>
        )
      },
    },
  })
}

const plugin: TuiPluginModule & { id: string } = { id, tui }

export default plugin
