// Pure formatting and state helpers for the dynamic workflow TUI surfaces: the /workflows dialog, the sidebar
// section, the workflow tool card and the ultracode prompt indicator. No Solid or SDK runtime imports, so they are
// shared by packages/opencode plugins and packages/tui renderers and tested directly.

import type { WorkflowAgentInfo, WorkflowPhaseInfo, WorkflowRunInfo } from "@kilocode/sdk/v2"

type Run = Pick<
  WorkflowRunInfo,
  "id" | "status" | "agents" | "done" | "error" | "skipped" | "running" | "tokens" | "started" | "ended"
>
type Agent = Pick<WorkflowAgentInfo, "id" | "phase" | "group" | "status" | "started" | "ended">
type Phase = Pick<WorkflowPhaseInfo, "title" | "total" | "running" | "done" | "error" | "skipped">

export namespace WorkflowView {
  /** Session metadata key the server writes for the ultracode toggle: `{ enabled: boolean }`. */
  export const KEY = "kilo.ultracode"

  /** Phase title used for agents that ran outside any phase. */
  export const LOOSE = "Agents"

  export type Tone = "success" | "warning" | "error" | "primary" | "muted"

  /** Effective ultracode state: the session toggle, else the `experimental.ultracode` default. */
  export function ultracode(metadata: Record<string, unknown> | undefined, fallback: boolean) {
    const value = metadata?.[KEY]
    if (!value || typeof value !== "object") return fallback
    const enabled = (value as { enabled?: unknown }).enabled
    return typeof enabled === "boolean" ? enabled : fallback
  }

  /** Epoch-millisecond timestamp, or undefined for anything that is not a finite number (missing, older servers). */
  export function time(value: unknown) {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined
  }

  /** Running and paused runs still hold agents or can start more. */
  export function active(status: WorkflowRunInfo["status"]) {
    return status === "running" || status === "paused"
  }

  /** Compact token count in Claude Code's style: `850 tok`, `1.2k tok`, `12k tok`, `1.5M tok`. */
  export function tokens(count: number) {
    if (count < 1000) return `${Math.max(0, Math.round(count))} tok`
    if (count < 10_000) return `${trim((count / 1000).toFixed(1))}k tok`
    const thousands = Math.round(count / 1000)
    if (thousands < 1000) return `${thousands}k tok`
    return `${trim((count / 1_000_000).toFixed(1))}M tok`
  }

  /** Compact duration: `45s`, `1m20s`, `1h05m`. */
  export function elapsed(ms: number) {
    const seconds = Math.max(0, Math.floor(ms / 1000))
    if (seconds < 60) return `${seconds}s`
    const minutes = Math.floor(seconds / 60)
    if (minutes < 60) return `${minutes}m${pad(seconds % 60)}s`
    return `${Math.floor(minutes / 60)}h${pad(minutes % 60)}m`
  }

  /** Elapsed time of a run or agent: until it ended, else until `now`. Undefined before it started. */
  export function duration(item: { started?: unknown; ended?: unknown }, now: number) {
    const start = time(item.started)
    if (start === undefined) return undefined
    return elapsed((time(item.ended) ?? now) - start)
  }

  /** `done/total agents`: finished agents (completed or replayed) over agents started so far. */
  export function agents(run: Pick<Run, "done" | "agents">) {
    return `${run.done}/${run.agents} ${run.agents === 1 ? "agent" : "agents"}`
  }

  /** One-line run progress: `3/10 agents · 12k tok · 1m20s`. */
  export function summary(run: Run, now: number) {
    const span = duration(run, now)
    return [agents(run), tokens(run.tokens), ...(span ? [span] : [])].join(" · ")
  }

  /** Short phase progress: `2/5 · 1 running · 1 failed`. */
  export function progress(phase: Phase) {
    return [
      `${phase.done}/${phase.total}`,
      ...(phase.running ? [`${phase.running} running`] : []),
      ...(phase.error ? [`${phase.error} failed`] : []),
      ...(phase.skipped ? [`${phase.skipped} skipped`] : []),
    ].join(" · ")
  }

  export function runTone(status: WorkflowRunInfo["status"]): Tone {
    if (status === "running") return "success"
    if (status === "paused") return "warning"
    if (status === "error") return "error"
    if (status === "completed") return "primary"
    return "muted"
  }

  export function agentTone(status: WorkflowAgentInfo["status"]): Tone {
    if (status === "running") return "success"
    if (status === "error") return "error"
    if (status === "completed" || status === "cached") return "primary"
    return "muted"
  }

  export function phaseTone(phase: Phase): Tone {
    if (phase.error > 0) return "error"
    if (phase.running > 0) return "success"
    if (phase.total > 0 && phase.done + phase.skipped === phase.total) return "primary"
    return "muted"
  }

  /** Theme color for a tone; works with the TUI theme and the plugin API theme alike. */
  export function paint<T>(theme: { success: T; warning: T; error: T; primary: T; textMuted: T }, tone: Tone) {
    return tone === "muted" ? theme.textMuted : theme[tone]
  }

  /** Human label for an agent status (`cached` is a replayed result from a resumed run). */
  export function agentStatus(status: WorkflowAgentInfo["status"]) {
    if (status === "cached") return "cached"
    if (status === "skipped") return "stopped"
    return status
  }

  /** Insert or replace a run by id, keeping launch order. */
  export function upsert<T extends Run>(list: readonly T[], run: T) {
    return sort([...list.filter((item) => item.id !== run.id), run])
  }

  /** Merge a fetched list into runs already known from events; event copies win because they can be newer. */
  export function merge<T extends Run>(fetched: readonly T[], known: readonly T[]) {
    const ids = new Set(known.map((item) => item.id))
    return sort([...fetched.filter((item) => !ids.has(item.id)), ...known])
  }

  /** Phase an agent counts toward: its nested-workflow group, else its phase, else the loose bucket. */
  export function bucket(agent: Pick<Agent, "phase" | "group">) {
    return agent.group ?? agent.phase ?? LOOSE
  }

  /**
   * Phases to show for a run: the server's phases (meta order, then `phase()` titles, then nested groups) plus a
   * loose bucket when some agents ran outside every phase. Empty phases are kept so planned work is visible.
   */
  export function phases<A extends Agent>(known: readonly WorkflowPhaseInfo[], list: readonly A[]) {
    const titles = new Set(known.map((item) => item.title))
    const loose = list.filter((item) => !titles.has(bucket(item)))
    if (loose.length === 0) return [...known]
    const count = (status: A["status"][]) => loose.filter((item) => status.includes(item.status)).length
    return [
      ...known,
      {
        title: LOOSE,
        total: loose.length,
        running: count(["running"]),
        done: count(["completed", "cached"]),
        error: count(["error"]),
        skipped: count(["skipped"]),
      },
    ]
  }

  /** Agents shown under one phase title (the loose bucket collects agents of no known phase). */
  export function members<A extends Agent>(
    title: string,
    known: readonly Pick<WorkflowPhaseInfo, "title">[],
    list: readonly A[],
  ) {
    const titles = new Set(known.map((item) => item.title))
    if (title === LOOSE && !titles.has(LOOSE)) return list.filter((item) => !titles.has(bucket(item)))
    return list.filter((item) => bucket(item) === title)
  }

  /**
   * Name and description of a not-yet-launched inline script, read from its leading `meta` literal for display only.
   * Never returns script text beyond those two strings.
   */
  export function preview(script: unknown) {
    if (typeof script !== "string") return {}
    const head = script.slice(0, 4000)
    return { name: field(head, "name"), description: field(head, "description") }
  }

  /** Path basename without the `.js` extension, for a `scriptPath` launch before metadata exists. */
  export function basename(file: unknown) {
    if (typeof file !== "string" || !file) return undefined
    return file.split(/[\\/]/).at(-1)?.replace(/\.js$/, "") || undefined
  }

  function field(text: string, key: string) {
    const match = new RegExp(`\\b${key}\\s*:\\s*(["'\`])((?:\\\\.|(?!\\1)[^\\\\])*)\\1`).exec(text)
    return match?.[2]?.replace(/\\(.)/g, "$1")
  }

  function sort<T extends Run>(list: T[]) {
    return list.toSorted((a, b) => (time(a.started) ?? 0) - (time(b.started) ?? 0))
  }

  function trim(value: string) {
    return value.replace(/\.0$/, "")
  }

  function pad(value: number) {
    return value.toString().padStart(2, "0")
  }
}
