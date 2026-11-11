// /workflows: Claude Code's workflow progress view for the TUI. Runs list → run (phases with agent counts) → phase
// agents → the agent's child session transcript. Keys follow Claude Code: ↑/↓ select, Enter/→ drill in, Esc/← back,
// x stop (selected agent or whole run), p pause/resume, s save the run's script as a saved workflow.

import type { WorkflowAgentInfo, WorkflowRunDetail, WorkflowRunInfo } from "@kilocode/sdk/v2"
import { TextAttributes } from "@opentui/core"
import { useEvent } from "@tui/context/event"
import { useProject } from "@tui/context/project"
import { useRoute } from "@tui/context/route"
import { useSDK } from "@tui/context/sdk"
import { useSync } from "@tui/context/sync"
import { useTheme } from "@tui/context/theme"
import { useBindings } from "@tui/keymap"
import { useDialog } from "@tui/ui/dialog"
import { DialogSelect, type DialogSelectOption, type DialogSelectRef } from "@tui/ui/dialog-select"
import { useToast } from "@tui/ui/toast"
import { KiloInstance } from "@tui/kilocode/instance"
import { errorMessage } from "@/util/error"
import { Locale } from "@/util/locale"
import { WorkflowView } from "@/kilocode/cli/cmd/tui/workflow-view"
import path from "path"
import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show, untrack } from "solid-js"
import { reconcile } from "solid-js/store"

type Run = WorkflowRunInfo
type Detail = WorkflowRunDetail
type Agent = WorkflowAgentInfo
type Scope = "project" | "global"

const STOP = "workflow.dialog.stop"
const PAUSE = "workflow.dialog.pause"
const SAVE = "workflow.dialog.save"

/** Ticks once a second while `live()` holds, so elapsed times of running work stay current. */
export function useNow(live: () => boolean) {
  const [now, setNow] = createSignal(Date.now())
  createEffect(() => {
    if (!live()) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    onCleanup(() => clearInterval(timer))
  })
  return now
}

/**
 * Workflow runs, live from `workflow.run.updated`. `scope()` returns `{ sessionID }` for one launching session,
 * `{}` for every run of the routed directory, or undefined to load nothing.
 */
export function useWorkflowRuns(scope: () => { sessionID?: string } | undefined) {
  const sdk = useSDK()
  const project = useProject()
  const event = useEvent()
  const [runs, setRuns] = createSignal<Run[]>([])
  const [loaded, setLoaded] = createSignal(false)
  const [epoch, setEpoch] = createSignal(0)
  const key = createMemo(
    () => {
      const value = scope()
      return value ? { sessionID: value.sessionID } : undefined
    },
    undefined,
    { equals: (a, b) => a?.sessionID === b?.sessionID && !a === !b },
  )
  // Each load gets a token so a slow response for a previous scope cannot overwrite the current one.
  let token: object | undefined

  createEffect(
    on([key, () => project.workspace.current(), epoch], ([value, workspace]) => {
      const current = {}
      token = current
      setRuns([])
      setLoaded(false)
      if (!value) return
      void sdk.client.workflow.list({ sessionID: value.sessionID, workspace }).then(
        (result) => {
          if (token !== current) return
          setRuns((known) => WorkflowView.merge(result.data ?? [], known))
          setLoaded(true)
        },
        () => {
          if (token === current) setLoaded(true)
        },
      )
    }),
  )

  onCleanup(
    event.on("workflow.run.updated", (evt) => {
      const value = key()
      if (!value) return
      if (value.sessionID && evt.properties.run.sessionID !== value.sessionID) return
      setRuns((list) => WorkflowView.upsert(list, evt.properties.run))
    }),
  )
  // A disposed instance takes its runs with it; reload so stopped runs do not linger as running. Only this directory's
  // instance holds them: a finished worktree agent disposes its own directory, which must not reset every view.
  onCleanup(
    event.on("server.instance.disposed", (evt) => {
      if (!KiloInstance.own(evt.properties.directory, project.instance.directory())) return
      setEpoch((value) => value + 1)
    }),
  )

  return { runs, loaded }
}

/** One run with its agents and logs. Refetched on each update event for the run (coalesced while a fetch runs). */
export function useWorkflowRun(runID: string) {
  const sdk = useSDK()
  const project = useProject()
  const event = useEvent()
  const [detail, setDetail] = createSignal<Detail>()
  const [state, setState] = createSignal<"loading" | "ready" | "missing">("loading")
  let busy = false
  let again = false
  let live = true
  onCleanup(() => {
    live = false
  })

  const load = async (): Promise<void> => {
    if (!live) return
    if (busy) {
      again = true
      return
    }
    busy = true
    const result = await sdk.client.workflow
      .get({ runID, workspace: project.workspace.current() })
      .catch((error: unknown) => ({ data: undefined, error }))
    busy = false
    if (result.data) {
      setDetail(result.data)
      setState("ready")
    }
    if (!result.data && !untrack(detail)) setState("missing")
    if (!again || !live) return
    again = false
    return load()
  }

  onMount(() => void load())
  onCleanup(
    event.on("workflow.run.updated", (evt) => {
      if (evt.properties.run.id !== runID) return
      setDetail((current) => (current ? { ...current, ...evt.properties.run } : current))
      void load()
    }),
  )
  // A disposed instance stops its runs without publishing; recheck so an open view does not stay "running".
  onCleanup(
    event.on("server.instance.disposed", (evt) => {
      if (!KiloInstance.own(evt.properties.directory, project.instance.directory())) return
      void sdk.client.workflow
        .get({ runID, workspace: project.workspace.current() })
        .catch((error: unknown) => ({ data: undefined, error }))
        .then((result) => {
          if (!live) return
          if (result.data) {
            setDetail(result.data)
            setState("ready")
            return
          }
          setState("missing")
          setDetail((current) =>
            current && WorkflowView.active(current.status) ? { ...current, status: "stopped" } : current,
          )
        })
    }),
  )

  return { detail, state }
}

function useActions() {
  const sdk = useSDK()
  const project = useProject()
  const sync = useSync()
  const toast = useToast()
  const [busy, setBusy] = createSignal<string>()

  async function call<T>(
    key: string,
    title: string,
    act: (workspace?: string) => Promise<{ data?: T; error?: unknown }>,
  ) {
    if (busy()) return
    setBusy(key)
    const result = await act(project.workspace.current()).catch((error: unknown) => ({ data: undefined, error }))
    setBusy(undefined)
    if (result.error === undefined) return result
    toast.show({ variant: "error", title, message: errorMessage(result.error) })
    return undefined
  }

  return {
    busy,
    stop(run: Pick<Run, "id" | "status">) {
      if (!WorkflowView.active(run.status)) return
      return call(`stop:${run.id}`, "Failed to stop workflow", (workspace) =>
        sdk.client.workflow.stop({ runID: run.id, workspace }),
      )
    },
    toggle(run: Pick<Run, "id" | "status">) {
      if (run.status === "paused")
        return call(`resume:${run.id}`, "Failed to resume workflow", (workspace) =>
          sdk.client.workflow.resume({ runID: run.id, workspace }),
        )
      if (run.status !== "running") return
      return call(`pause:${run.id}`, "Failed to pause workflow", (workspace) =>
        sdk.client.workflow.pause({ runID: run.id, workspace }),
      )
    },
    agent(run: Pick<Run, "id">, agent: Pick<Agent, "id" | "status">) {
      if (agent.status !== "running" && agent.status !== "queued") return
      return call(`agent:${run.id}:${agent.id}`, "Failed to stop agent", (workspace) =>
        sdk.client.workflow.agentStop({ runID: run.id, agentID: agent.id, workspace }),
      )
    },
    async save(run: Pick<Run, "id" | "name">, scope: Scope) {
      const result = await call(`save:${run.id}`, "Failed to save workflow", (workspace) =>
        sdk.client.workflow.save({ runID: run.id, scope, workspace }),
      )
      const file = result?.data?.path
      if (!file) return false
      toast.show({ variant: "success", title: `Saved workflow "${run.name}"`, message: file })
      // The server lists the saved workflow as a command right away; refetch so `/<name>` autocompletes and submits as
      // a command in this TUI too (the list is otherwise only fetched at bootstrap).
      void sdk.client.command
        .list({ workspace: project.workspace.current() })
        .then((list) => {
          if (list.data) sync.set("command", reconcile(list.data))
        })
        .catch((error: unknown) => toast.show({ variant: "error", message: errorMessage(error) }))
      return true
    },
  }
}

/** Esc, ← and backspace go one level up instead of closing (outranks the dialog's own Esc). */
function useBack(back: (() => void) | undefined) {
  useBindings(() => ({
    priority: 1,
    bindings: back
      ? [
          { key: "escape", desc: "Back", group: "Workflows", cmd: back },
          { key: "left", desc: "Back", group: "Workflows", cmd: back },
          { key: "backspace", desc: "Back", group: "Workflows", cmd: back },
        ]
      : [],
  }))
}

function Mark(props: { tone: WorkflowView.Tone }) {
  const { theme } = useTheme()
  return <text fg={WorkflowView.paint(theme, props.tone)}>*</text>
}

function Header(props: { title: string; status?: Run["status"]; lines: (string | undefined)[]; error?: string }) {
  const { theme } = useTheme()
  const lines = createMemo(() => props.lines.filter((line): line is string => Boolean(line)))
  return (
    <box flexGrow={1} flexShrink={1}>
      <text fg={theme.text} wrapMode="none">
        <span style={{ attributes: TextAttributes.BOLD }}>{props.title}</span>
        <Show when={props.status}>
          {(status) => (
            <span style={{ fg: WorkflowView.paint(theme, WorkflowView.runTone(status())) }}> {status()}</span>
          )}
        </Show>
      </text>
      <For each={lines()}>
        {(line) => (
          <text fg={theme.textMuted} wrapMode="word">
            {line}
          </text>
        )}
      </For>
      <Show when={props.error}>
        {(error) => (
          <text fg={theme.error} wrapMode="word">
            {error()}
          </text>
        )}
      </Show>
    </box>
  )
}

function line(text: string | undefined, max = 160) {
  if (!text) return undefined
  return Locale.truncate(text.replace(/\s+/g, " ").trim(), max)
}

function model(agent: Pick<Agent, "model" | "variant">) {
  if (!agent.model) return undefined
  return agent.variant ? `${agent.model} (${agent.variant})` : agent.model
}

/** Run list for a session (or every run when no session is given). Opens the only run directly, like Claude Code. */
export function DialogWorkflows(props: { sessionID?: string; auto?: boolean }) {
  const dialog = useDialog()
  const actions = useActions()
  const data = useWorkflowRuns(() => ({ sessionID: props.sessionID }))
  const now = useNow(() => data.runs().some((run) => WorkflowView.active(run.status)))
  const find = (id: string) => data.runs().find((run) => run.id === id)
  const [cursor, setCursor] = createSignal<string>()
  const list = () => <DialogWorkflows sessionID={props.sessionID} auto={false} />
  const open = (runID: string, top: boolean) =>
    dialog.replace(() => <DialogWorkflowRun runID={runID} back={top ? undefined : () => dialog.replace(list)} />)

  onMount(() => dialog.setSize("large"))

  // Only the first load may open the only run: a reload after an instance disposal must not pull the user out of the list.
  let first = props.auto !== false
  createEffect(
    on(
      data.loaded,
      (ready) => {
        if (!ready || !first) return
        first = false
        const runs = untrack(data.runs)
        const only = runs.length === 1 ? runs.at(0) : undefined
        if (only) open(only.id, true)
      },
      { defer: true },
    ),
  )

  const options = createMemo<DialogSelectOption<string>[]>(() =>
    data
      .runs()
      .toReversed()
      .map((run) => ({
        title: run.name,
        value: run.id,
        description: run.description,
        footer: `${run.status} · ${WorkflowView.summary(run, now())}`,
        gutter: () => <Mark tone={WorkflowView.runTone(run.status)} />,
      })),
  )
  // DialogSelect keeps the first row it showed selected when newer runs are prepended; track it the same way.
  createEffect(() => {
    const first = options().at(0)?.value
    if (first && !untrack(cursor)) setCursor(first)
  })

  return (
    <DialogSelect
      title={props.sessionID ? "Workflows (current session)" : "Workflows"}
      options={options()}
      renderFilter={false}
      preserveSelection
      emptyView={<Empty text={data.loaded() ? "No workflow runs yet." : "Loading workflows…"} />}
      onMove={(option) => setCursor(option.value)}
      onSelect={(option) => open(option.value, false)}
      actions={[
        {
          command: STOP,
          title: "stop",
          disabled: (option) => !option || !WorkflowView.active(find(option.value)?.status ?? "stopped"),
          onTrigger: (option) => {
            const run = find(option.value)
            if (run) void actions.stop(run)
          },
        },
        {
          command: PAUSE,
          title: "pause/resume",
          disabled: (option) => !option || !WorkflowView.active(find(option.value)?.status ?? "stopped"),
          onTrigger: (option) => {
            const run = find(option.value)
            if (run) void actions.toggle(run)
          },
        },
        {
          command: SAVE,
          title: "save",
          side: "right",
          onTrigger: (option) => {
            const run = find(option.value)
            if (run) dialog.replace(() => <DialogWorkflowSave run={run} back={() => dialog.replace(list)} />)
          },
        },
      ]}
      bindings={[
        { key: "x", cmd: STOP },
        { key: "p", cmd: PAUSE },
        { key: "s", cmd: SAVE },
        {
          key: "right",
          desc: "Open run",
          group: "Workflows",
          cmd: () => {
            const value = cursor() ?? options().at(0)?.value
            if (value && find(value)) open(value, false)
          },
        },
      ]}
    />
  )
}

function Empty(props: { text: string }) {
  const { theme } = useTheme()
  return (
    <box paddingLeft={4} paddingRight={4} paddingTop={1}>
      <text fg={theme.textMuted}>{props.text}</text>
    </box>
  )
}

/** One run: header with progress and narrator logs, then its phases. Enter/→ lists a phase's agents. */
export function DialogWorkflowRun(props: { runID: string; back?: () => void }) {
  const dialog = useDialog()
  const actions = useActions()
  const run = useWorkflowRun(props.runID)
  const status = createMemo(() => run.detail()?.status)
  const now = useNow(() => WorkflowView.active(status() ?? "stopped"))
  const phases = createMemo(() => {
    const detail = run.detail()
    return detail ? WorkflowView.phases(detail.phases, detail.list) : []
  })
  const [cursor, setCursor] = createSignal<string>()
  const self = () => <DialogWorkflowRun runID={props.runID} back={props.back} />
  const drill = (phase: string) =>
    dialog.replace(() => <DialogWorkflowAgents runID={props.runID} phase={phase} back={() => dialog.replace(self)} />)

  useBack(props.back)
  onMount(() => dialog.setSize("large"))

  const options = createMemo<DialogSelectOption<string>[]>(() =>
    phases().map((phase) => ({
      title: phase.title,
      value: phase.title,
      description: phase.detail,
      footer: WorkflowView.progress(phase),
      gutter: () => <Mark tone={WorkflowView.phaseTone(phase)} />,
    })),
  )

  const header = () => {
    const detail = run.detail()
    if (!detail) return <Header title="Workflow" lines={[run.state() === "missing" ? undefined : "Loading…"]} />
    const extra = detail.cached ? ` · ${detail.cached} cached` : ""
    return (
      <Header
        title={detail.name}
        status={detail.status}
        lines={[
          line(detail.description, 240),
          run.state() === "missing" ? "This workflow run is no longer tracked by the server." : undefined,
          `${WorkflowView.summary(detail, now())}${extra}`,
          ...detail.logs.slice(-3).map((item) => line(`› ${item}`)),
        ]}
        error={detail.error_message}
      />
    )
  }

  return (
    <DialogSelect
      title={run.detail()?.name ?? "Workflow"}
      titleView={header()}
      options={options()}
      renderFilter={false}
      preserveSelection
      onMove={(option) => setCursor(option.value)}
      onSelect={(option) => drill(option.value)}
      emptyView={
        <Empty
          text={
            run.state() === "missing"
              ? "This workflow run is no longer tracked by the server."
              : run.state() === "loading"
                ? "Loading…"
                : "No agents have started yet."
          }
        />
      }
      actions={[
        {
          command: STOP,
          title: "stop run",
          requiresSelection: false,
          disabled: !WorkflowView.active(status() ?? "stopped"),
          onTrigger: () => {
            const detail = run.detail()
            if (detail) void actions.stop(detail)
          },
        },
        {
          command: PAUSE,
          title: status() === "paused" ? "resume" : "pause",
          requiresSelection: false,
          disabled: !WorkflowView.active(status() ?? "stopped"),
          onTrigger: () => {
            const detail = run.detail()
            if (detail) void actions.toggle(detail)
          },
        },
        {
          command: SAVE,
          title: "save",
          side: "right",
          requiresSelection: false,
          disabled: !status(),
          onTrigger: () => {
            const detail = run.detail()
            if (detail) dialog.replace(() => <DialogWorkflowSave run={detail} back={() => dialog.replace(self)} />)
          },
        },
      ]}
      bindings={[
        { key: "x", cmd: STOP },
        { key: "p", cmd: PAUSE },
        { key: "s", cmd: SAVE },
        {
          key: "right",
          desc: "Open phase",
          group: "Workflows",
          cmd: () => {
            const value = cursor() ?? options().at(0)?.value
            if (value) drill(value)
          },
        },
      ]}
    />
  )
}

/** Agents of one phase. Enter/→ opens the agent's child session; x stops the selected agent. */
function DialogWorkflowAgents(props: { runID: string; phase: string; back: () => void }) {
  const dialog = useDialog()
  const route = useRoute()
  const toast = useToast()
  const actions = useActions()
  const run = useWorkflowRun(props.runID)
  const status = createMemo(() => run.detail()?.status)
  const list = createMemo(() => {
    const detail = run.detail()
    return detail ? WorkflowView.members(props.phase, detail.phases, detail.list) : []
  })
  const now = useNow(() => list().some((agent) => agent.status === "running"))
  const [cursor, setCursor] = createSignal<string>()
  const selected = createMemo(() => {
    const id = cursor()
    return list().find((agent) => agent.id === id) ?? list().at(0)
  })
  const phases = createMemo(() => {
    const detail = run.detail()
    return detail ? WorkflowView.phases(detail.phases, detail.list) : []
  })
  const self = () => <DialogWorkflowAgents runID={props.runID} phase={props.phase} back={props.back} />

  useBack(props.back)
  onMount(() => dialog.setSize("large"))

  const open = (agentID: string) => {
    const agent = list().find((item) => item.id === agentID)
    if (!agent?.sessionID) {
      toast.show({ variant: "info", message: "This agent has not started a session yet" })
      return
    }
    route.navigate({ type: "session", sessionID: agent.sessionID })
    dialog.clear()
  }

  const options = createMemo<DialogSelectOption<string>[]>(() =>
    list().map((agent) => {
      const time = WorkflowView.duration(agent, now())
      return {
        title: agent.label,
        value: agent.id,
        description: model(agent),
        footer: [
          WorkflowView.agentStatus(agent.status),
          ...(agent.tools ? [`${agent.tools} ${agent.tools === 1 ? "tool" : "tools"}`] : []),
          WorkflowView.tokens(agent.tokens),
          ...(time ? [time] : []),
        ].join(" · "),
        gutter: () => <Mark tone={WorkflowView.agentTone(agent.status)} />,
      }
    }),
  )

  const header = () => {
    const detail = run.detail()
    const phase = phases().find((item) => item.title === props.phase)
    const agent = selected()
    return (
      <Header
        title={`${detail?.name ?? "Workflow"} › ${props.phase}`}
        status={detail?.status}
        lines={[
          phase ? WorkflowView.progress(phase) : undefined,
          agent ? line(`Prompt: ${agent.prompt}`, 240) : undefined,
          agent?.result ? line(`Result: ${agent.result}`, 240) : undefined,
          agent?.worktree
            ? line(`Worktree: ${agent.worktree.path}${agent.worktree.branch ? ` (${agent.worktree.branch})` : ""}`)
            : undefined,
        ]}
        error={agent?.error ? line(agent.error, 240) : undefined}
      />
    )
  }
  return (
    <DialogSelect
      title={props.phase}
      titleView={header()}
      options={options()}
      renderFilter={false}
      preserveSelection
      onMove={(option) => setCursor(option.value)}
      onSelect={(option) => open(option.value)}
      emptyView={<Empty text={run.state() === "loading" ? "Loading…" : "No agents in this phase yet."} />}
      actions={[
        {
          command: STOP,
          title: "stop agent",
          disabled: (option) => {
            const agent = list().find((item) => item.id === option?.value)
            return agent?.status !== "running" && agent?.status !== "queued"
          },
          onTrigger: (option) => {
            const agent = list().find((item) => item.id === option.value)
            if (agent) void actions.agent({ id: props.runID }, agent)
          },
        },
        {
          command: PAUSE,
          title: status() === "paused" ? "resume" : "pause",
          requiresSelection: false,
          disabled: !WorkflowView.active(status() ?? "stopped"),
          onTrigger: () => {
            const detail = run.detail()
            if (detail) void actions.toggle(detail)
          },
        },
        {
          command: SAVE,
          title: "save",
          side: "right",
          requiresSelection: false,
          disabled: !status(),
          onTrigger: () => {
            const detail = run.detail()
            if (detail) dialog.replace(() => <DialogWorkflowSave run={detail} back={() => dialog.replace(self)} />)
          },
        },
      ]}
      bindings={[
        { key: "x", cmd: STOP },
        { key: "p", cmd: PAUSE },
        { key: "s", cmd: SAVE },
        {
          key: "right",
          desc: "Open agent session",
          group: "Workflows",
          cmd: () => {
            const agent = selected()
            if (agent) open(agent.id)
          },
        },
      ]}
    />
  )
}

/**
 * Save a run's script as a saved workflow: the project's .kilo/workflows/ or the global workflows directory, shown as
 * the resolved path the server writes to. Tab toggles between the two locations, like Claude Code.
 */
function DialogWorkflowSave(props: { run: Pick<Run, "id" | "name">; back: () => void }) {
  const actions = useActions()
  const project = useProject()
  const [scope, setScope] = createSignal<Scope>("project")
  const global = createMemo(() => {
    const dir = project.instance.path().config
    return dir ? `${path.join(dir, "workflows")}${path.sep}` : "~/.config/kilo/workflows/"
  })
  const [select, setSelect] = createSignal<DialogSelectRef<Scope>>()
  const dialog = useDialog()
  useBack(props.back)
  onMount(() => dialog.setSize("large"))
  return (
    <DialogSelect<Scope>
      ref={setSelect}
      title={`Save workflow "${props.run.name}"`}
      renderFilter={false}
      locked={actions.busy() !== undefined}
      options={[
        { title: "Project", value: "project", description: ".kilo/workflows/ in this project" },
        { title: "Global", value: "global", description: `${global()} for every project` },
      ]}
      onMove={(option) => setScope(option.value)}
      onSelect={async (option) => {
        if (await actions.save(props.run, option.value)) props.back()
      }}
      bindings={[
        {
          key: "tab",
          desc: "Toggle save location",
          group: "Workflows",
          cmd: () => select()?.moveTo(scope() === "project" ? "global" : "project"),
        },
      ]}
    />
  )
}
