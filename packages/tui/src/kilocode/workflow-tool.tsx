import type { ToolPart, WorkflowRunInfo } from "@kilocode/sdk/v2"
import type { JSX } from "@opentui/solid"
import { createMemo, Match, Show, Switch, type Component } from "solid-js"
import { useSync } from "../context/sync"
import { useTheme } from "../context/theme"
import { useDialog } from "../ui/dialog"
import { isRecord } from "../util/record"
import { DialogWorkflowRun, useNow, useWorkflowRuns } from "@/kilocode/cli/cmd/tui/component/dialog-workflows"
import { WorkflowView } from "@/kilocode/cli/cmd/tui/workflow-view"

type Block = Component<{
  title: string
  part: ToolPart
  spinner: boolean
  onClick?: () => void
  children: JSX.Element
}>

function text(value: unknown) {
  return typeof value === "string" && value ? value : undefined
}

function metadata(part: ToolPart): Record<string, unknown> {
  if (part.state.status === "pending") return {}
  return isRecord(part.state.metadata) ? part.state.metadata : {}
}

/** The `workflow` tool call: run name and description, then the live run's status, progress and phases. */
export function WorkflowTool(props: { part: ToolPart; block: Block }) {
  const dialog = useDialog()
  const sync = useSync()
  const runID = createMemo(() => text(metadata(props.part).runID))
  const data = useWorkflowRuns(() => (runID() ? { sessionID: props.part.sessionID } : undefined))
  const run = createMemo(() => data.runs().find((item) => item.id === runID()))
  const now = useNow(() => WorkflowView.active(run()?.status ?? "stopped"))
  const large = createMemo(() => {
    const item = run()
    if (!item || !WorkflowView.active(item.status)) return false
    const config = sync.data.config.experimental
    const session = WorkflowView.root((id) => sync.session.get(id)?.parentID, item.sessionID)
    return WorkflowView.large(item, {
      configured: config?.workflow_size,
      ultracode: WorkflowView.ultracode(sync.session.get(session)?.metadata, config?.ultracode === true),
    })
  })
  const open = () => {
    const id = runID()
    if (!id) return
    dialog.replace(() => <DialogWorkflowRun runID={id} />)
  }

  return (
    <WorkflowCard
      part={props.part}
      block={props.block}
      run={run()}
      loaded={data.loaded()}
      now={now()}
      large={large()}
      onOpen={runID() ? open : undefined}
    />
  )
}

/** Presentational card; never renders the script itself, only names read from metadata or the meta literal. */
export function WorkflowCard(props: {
  part: ToolPart
  block: Block
  run?: WorkflowRunInfo
  loaded?: boolean
  now: number
  large?: boolean
  onOpen?: () => void
}) {
  const { theme } = useTheme()
  const meta = createMemo(() => metadata(props.part))
  const input = createMemo(() => props.part.state.input ?? {})
  const draft = createMemo(() => WorkflowView.preview(input().script))
  const name = createMemo(
    () =>
      text(meta().name) ??
      props.run?.name ??
      text(input().name) ??
      draft().name ??
      WorkflowView.basename(input().scriptPath),
  )
  const description = createMemo(() => text(meta().description) ?? props.run?.description ?? draft().description)
  const title = createMemo(() =>
    ["◆ Workflow", name(), ...(description() ? [`— ${description()}`] : [])].filter(Boolean).join(" "),
  )
  const pending = createMemo(() => props.part.state.status === "pending" || props.part.state.status === "running")
  const runID = createMemo(() => text(meta().runID))

  return (
    <props.block
      title={title()}
      part={props.part}
      spinner={pending() || props.run?.status === "running"}
      onClick={props.onOpen}
    >
      <Switch>
        <Match when={props.run}>
          {(run) => (
            <box>
              <text fg={theme.textMuted} wrapMode="word">
                <span style={{ fg: WorkflowView.paint(theme, WorkflowView.runTone(run().status)) }}>
                  {run().status}
                </span>
                {" · "}
                {WorkflowView.summary(run(), props.now)}
                {` · ${run().size} size`}
              </text>
              <Show when={props.large}>
                <text fg={theme.warning}>{WorkflowView.LARGE}</text>
              </Show>
              <Show when={run().phases.length > 0}>
                <text fg={theme.textMuted} wrapMode="word">
                  {run()
                    .phases.map((phase) => `${phase.title} ${phase.done}/${phase.total}`)
                    .join(" · ")}
                </text>
              </Show>
              <Show when={run().error_message}>
                {(error) => (
                  <text fg={theme.error} wrapMode="word">
                    {error()}
                  </text>
                )}
              </Show>
            </box>
          )}
        </Match>
        <Match when={pending()}>
          <text fg={theme.textMuted}>Preparing workflow…</text>
        </Match>
        <Match when={runID()}>
          {(id) => (
            <text fg={theme.textMuted}>
              {props.loaded ? `Run ${id()} is no longer tracked` : `Background run ${id()}`}
            </text>
          )}
        </Match>
      </Switch>
    </props.block>
  )
}
