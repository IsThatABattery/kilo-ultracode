/**
 * Renderer for the `workflow` tool (dynamic workflows). The tool only launches a
 * background run, so the card never shows the script: it shows the workflow's
 * name and description from the tool metadata, then live progress from
 * `workflowRunUpdated` events. Expanding it loads the agent list; an agent with
 * a session opens its transcript the same way the task card does.
 *
 * Call registerWorkflowTool() once at app startup.
 */

import { type Component, createEffect, createMemo, createSignal, For, Index, on, onCleanup, Show } from "solid-js"
import { ToolRegistry, type ToolProps } from "@kilocode/kilo-ui/message-part"
import { BasicTool, initialOpen } from "@kilocode/kilo-ui/basic-tool"
import { Icon, type IconProps } from "@kilocode/kilo-ui/icon"
import { IconButton } from "@kilocode/kilo-ui/icon-button"
import { Tooltip } from "@kilocode/kilo-ui/tooltip"
import { showToast } from "@kilocode/kilo-ui/toast"
import { useI18n } from "@kilocode/kilo-ui/context/i18n"
import { useLanguage } from "../../context/language"
import { useSession } from "../../context/session"
import { useVSCode } from "../../context/vscode"
import { useWorktreeMode } from "../../context/worktree-mode"
import type { WorkflowAgent, WorkflowAgentStatus, WorkflowRun, WorkflowRunDetail } from "../../types/messages"
import { openSubagent } from "./open-subagent"
import { workflowActions, workflowAgents, workflowKey, workflowTerminal, workflowTokens } from "./workflow-tool-state"

// Last known summary per run, so a card the virtualizer remounts starts from it
// instead of flashing back to the metadata-only state.
const runs = new Map<string, WorkflowRun>()
const RELOAD = 1000

const ICON: Record<WorkflowAgentStatus, IconProps["name"]> = {
  queued: "dash",
  running: "status-active",
  completed: "check-small",
  cached: "history",
  error: "circle-x",
  skipped: "circle-ban-sign",
}

function text(value: unknown) {
  return typeof value === "string" && value ? value : undefined
}

const WorkflowTool: Component<ToolProps> = (props) => {
  const language = useLanguage()
  const i18n = useI18n()
  const session = useSession()
  const vscode = useVSCode()
  const worktree = useWorktreeMode()

  const id = () => text(props.metadata.runID)
  const name = () => text(props.metadata.name)
  const description = () => text(props.metadata.description)
  const [run, setRun] = createSignal<WorkflowRun | undefined>(id() ? runs.get(id()!) : undefined)
  // The launching session picks the backend directory; before the first update it is the open session.
  const owner = () => run()?.sessionID ?? props.sessionID ?? session.currentSessionID()
  const [detail, setDetail] = createSignal<WorkflowRunDetail>()
  // BasicTool restores a stored open state on remount; start from it so the agent list loads.
  const [open, setOpen] = createSignal(
    initialOpen({ tool: props.tool, partID: props.partID, defaultOpen: false, forceOpen: props.forceOpen }),
  )
  const [busy, setBusy] = createSignal(false)

  const keep = (next: WorkflowRun) => {
    runs.set(next.id, next)
    setRun(next)
  }

  const request = () => {
    const rid = id()
    const sid = owner()
    if (rid && sid) vscode.postMessage({ type: "requestWorkflowRun", runID: rid, sessionID: sid })
  }

  // Reload the agent list at most once a second while the card is open.
  const reload = { timer: undefined as ReturnType<typeof setTimeout> | undefined, at: 0 }
  const schedule = () => {
    if (reload.timer) return
    const wait = Math.max(0, reload.at + RELOAD - Date.now())
    reload.timer = setTimeout(() => {
      reload.timer = undefined
      reload.at = Date.now()
      request()
    }, wait)
  }
  onCleanup(() => clearTimeout(reload.timer))

  const unsub = vscode.onMessage((message) => {
    if (message.type === "workflowRunUpdated" && message.run.id === id()) {
      setBusy(false)
      keep(message.run)
      return
    }
    if (message.type !== "workflowRunLoaded" || message.runID !== id()) return
    if (message.run) {
      keep(message.run)
      setDetail(message.run)
    }
    // Load failures (for example a run from an earlier backend process) keep the
    // metadata-only card; only a failed control action is worth a toast.
    if (message.error && busy()) {
      showToast({ variant: "error", title: language.t("common.requestFailed"), description: message.error })
    }
    setBusy(false)
  })
  onCleanup(unsub)

  // A live run sends events; fetch once so a reopened transcript starts current.
  createEffect(
    on(id, (rid) => {
      if (!rid || workflowTerminal(runs.get(rid)?.status)) return
      request()
    }),
  )

  createEffect(
    on([open, () => workflowKey(run())], ([value], prev) => {
      if (!value) return
      if (!prev?.[0] || !detail()) {
        request()
        return
      }
      schedule()
    }),
  )

  const status = () => run()?.status
  const actions = createMemo(() => workflowActions(status(), props.readonly))
  const tokens = (count: number) => workflowTokens(count, i18n.locale())

  const progress = createMemo(() => {
    const value = run()
    if (!value) return undefined
    return [
      language.t(`workflow.status.${value.status}`),
      language.t("workflow.agents", { done: String(value.done), total: String(value.agents) }),
      language.t("workflow.tokens", { count: tokens(value.tokens) }),
    ].join(" · ")
  })

  const act = (action: "stop" | "pause" | "resume", agent?: string) => (e: MouseEvent) => {
    e.stopPropagation()
    const rid = id()
    const sid = owner()
    if (!rid || !sid) return
    setBusy(true)
    vscode.postMessage({
      type: "workflowControl",
      action,
      runID: rid,
      sessionID: sid,
      ...(agent ? { agentID: agent } : {}),
    })
  }

  const reveal = (agent: WorkflowAgent) => {
    if (!agent.sessionID) return
    openSubagent({
      sessionID: agent.sessionID,
      title: agent.label,
      parentSessionID: owner(),
      worktree: !!worktree,
      post: vscode.postMessage,
    })
  }

  const agents = createMemo(() => workflowAgents(detail()?.list ?? []))
  const phases = () => run()?.phases.filter((phase) => phase.total > 0) ?? []

  const trigger = () => (
    <div data-slot="basic-tool-tool-info-structured" data-component="task-tool-heading">
      <div data-slot="basic-tool-tool-info-main">
        <span data-slot="basic-tool-tool-title" title={description() ?? name()}>
          {language.t("workflow.title", { name: name() ?? "" }).trim()}
        </span>
        <Show when={description() || progress()}>
          <span data-slot="basic-tool-tool-subtitle" title={progress()}>
            {[description(), progress()].filter(Boolean).join(" — ")}
          </span>
        </Show>
      </div>
      <Show when={actions().pause}>
        <Tooltip value={language.t("workflow.pause")} placement="top">
          <IconButton
            icon="pause"
            size="small"
            variant="ghost"
            aria-label={language.t("workflow.pause")}
            disabled={busy()}
            onClick={act("pause")}
          />
        </Tooltip>
      </Show>
      <Show when={actions().resume}>
        <Tooltip value={language.t("workflow.resume")} placement="top">
          <IconButton
            icon="play"
            size="small"
            variant="ghost"
            aria-label={language.t("workflow.resume")}
            disabled={busy()}
            onClick={act("resume")}
          />
        </Tooltip>
      </Show>
      <Show when={actions().stop}>
        <Tooltip value={language.t("workflow.stop")} placement="top">
          <IconButton
            icon="stop"
            size="small"
            variant="ghost"
            aria-label={language.t("workflow.stop")}
            disabled={busy()}
            onClick={act("stop")}
          />
        </Tooltip>
      </Show>
    </div>
  )

  return (
    <div data-component="tool-part-wrapper">
      <BasicTool
        icon="layers"
        status={props.status}
        tool={props.tool}
        partID={props.partID}
        trigger={trigger()}
        defaultOpen={false}
        forceOpen={props.forceOpen}
        onOpenChange={setOpen}
      >
        <Show when={run()}>
          <div data-component="tool-output" data-scrollable>
            <div data-component="task-tools" data-variant="workflow">
              <For each={phases()}>
                {(phase) => (
                  <div data-slot="task-tool-item">
                    <Icon name="layers" size="small" />
                    <span data-slot="task-tool-title">{phase.title}</span>
                    <span data-slot="task-tool-subtitle">
                      {[
                        `${phase.done}/${phase.total}`,
                        phase.running ? language.t("workflow.running", { count: String(phase.running) }) : "",
                        phase.error ? language.t("workflow.failed", { count: String(phase.error) }) : "",
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  </div>
                )}
              </For>
              <Show when={run()?.error_message}>
                {(message) => (
                  <div data-slot="task-tool-item" data-state="error">
                    <Icon name="circle-x" size="small" />
                    <span data-slot="task-tool-subtitle">{message()}</span>
                  </div>
                )}
              </Show>
              <Show when={!detail() && (run()?.agents ?? 0) > 0}>
                <div data-slot="task-tool-item">
                  <span data-slot="task-tool-subtitle">{language.t("workflow.loading")}</span>
                </div>
              </Show>
              <Index each={agents()}>
                {(agent) => (
                  <div
                    data-slot="task-tool-item"
                    data-workflow-agent
                    data-clickable={agent().sessionID ? "true" : undefined}
                    title={agent().sessionID ? language.t("workflow.agent.open") : undefined}
                    onClick={() => reveal(agent())}
                  >
                    <Icon name={ICON[agent().status]} size="small" />
                    <span data-slot="task-tool-title">{agent().label}</span>
                    <span data-slot="task-tool-subtitle">
                      {[
                        language.t(`workflow.agent.status.${agent().status}`),
                        agent().tokens ? language.t("workflow.tokens", { count: tokens(agent().tokens) }) : "",
                        agent().error ?? "",
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                    <Show when={agent().status === "running" && actions().stop}>
                      <IconButton
                        icon="stop"
                        size="small"
                        variant="ghost"
                        data-slot="workflow-agent-stop"
                        aria-label={language.t("workflow.agent.stop")}
                        title={language.t("workflow.agent.stop")}
                        disabled={busy()}
                        onClick={(e) => act("stop", agent().id)(e)}
                      />
                    </Show>
                  </div>
                )}
              </Index>
            </div>
          </div>
        </Show>
      </BasicTool>
    </div>
  )
}

export function registerWorkflowTool() {
  ToolRegistry.register({
    name: "workflow",
    render: WorkflowTool,
  })
}
