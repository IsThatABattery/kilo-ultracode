import { Effect, Option } from "effect"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import type { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Permission } from "@/permission"
import { PartID, type SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { KiloSessionPrompt } from "@/kilocode/session/prompt"
import { KiloWorkflowEnabled } from "./enabled"
import { WorkflowPrompts } from "./prompts"

/**
 * Ultracode: a per-session standing opt-in to multi-agent orchestration (Claude Code's ultracode mode).
 *
 * The toggle lives in session metadata so it survives turns a client did not author (background results, goal
 * continuations, compaction "continue"). While it is on, every turn's last user message gets one persisted
 * reminder; switching it off adds a single "off" reminder; a human-typed "ultracode" keyword opts in one turn.
 */
export namespace KiloUltracode {
  /** Session metadata key: `{ enabled: boolean }`. */
  export const KEY = "kilo.ultracode"

  /** Session metadata key the spawn layer sets on workflow agent sessions. */
  export const WORKFLOW = "kilo.workflow"

  export type Reminder = "ultracode" | "ultracode-off" | "ultracode-keyword"

  type Settings = Parameters<typeof KiloWorkflowEnabled.enabled>[0]
  type Flags = Parameters<typeof KiloWorkflowEnabled.enabled>[1]
  type Part = {
    type: string
    text?: string
    synthetic?: boolean
    ignored?: boolean
    metadata?: Record<string, unknown>
  }

  const KEYWORD = /\bultracode\b/i

  export function read(metadata: Record<string, unknown> | undefined): { enabled?: boolean } {
    const value = metadata?.[KEY]
    if (!value || typeof value !== "object") return {}
    const enabled = (value as { enabled?: unknown }).enabled
    return typeof enabled === "boolean" ? { enabled } : {}
  }

  /** Persist the toggle, merging into fresh metadata so other keys (e.g. `kilo.goal`) survive. No-op if unchanged. */
  export const set = Effect.fn("KiloUltracode.set")(function* (sessionID: SessionID, enabled: boolean) {
    const sessions = yield* Session.Service
    const fresh = yield* sessions.get(sessionID)
    if (read(fresh.metadata).enabled === enabled) return
    yield* sessions.setMetadata({ sessionID, metadata: { ...fresh.metadata, [KEY]: { enabled } } })
  })

  /** Effective state: workflows must be enabled; the session toggle wins over the `experimental.ultracode` default. */
  export function enabled(session: { metadata?: Record<string, unknown> }, cfg: Settings, flags: Flags) {
    if (!KiloWorkflowEnabled.enabled(cfg, flags)) return false
    return read(session.metadata).enabled ?? KiloWorkflowEnabled.ultracode(cfg)
  }

  /**
   * True when a human-typed text part mentions the keyword. Synthetic, ignored, and Kilo-injected text (slash-command
   * templates, composed prompts) never counts, nor does headless text (`kilo run` prompts, relayed GitHub comments),
   * text whose keyword the user dismissed in the prompt (`noUltracode`), or text that is itself a slash command.
   */
  export function keyword(parts: ReadonlyArray<Part>) {
    return parts.some((part) => {
      if (part.type !== "text" || !part.text) return false
      if (part.synthetic || part.ignored) return false
      if (exempt(part.metadata)) return false
      if (part.text.trimStart().startsWith("/")) return false
      return KEYWORD.test(part.text)
    })
  }

  /** Reminders go to root sessions only: never task children or workflow agent sessions. */
  export function root(session: Pick<Session.Info, "parentID" | "metadata">) {
    return !session.parentID && !session.metadata?.[WORKFLOW]
  }

  function exempt(metadata: Record<string, unknown> | undefined) {
    const kilo = metadata?.kilo
    if (!kilo || typeof kilo !== "object") return false
    const value = kilo as { injected?: unknown; origin?: unknown; noUltracode?: unknown }
    return !!value.injected || value.origin === "headless" || value.noUltracode === true
  }

  function reminder(part: SessionV1.Part): Reminder | undefined {
    if (part.type !== "text") return
    const kilo = part.metadata?.kilo
    if (!kilo || typeof kilo !== "object") return
    const value = (kilo as { reminder?: unknown }).reminder
    if (value === "ultracode" || value === "ultracode-off" || value === "ultracode-keyword") return value
  }

  /** Latest on/off reminder in the loaded history, newest first. */
  function latest(messages: SessionV1.WithParts[]) {
    for (const msg of messages.toReversed()) {
      for (const part of msg.parts.toReversed()) {
        const kind = reminder(part)
        if (kind === "ultracode" || kind === "ultracode-off") return kind
      }
    }
  }

  function disabled(input: { agent: Agent.Info; session: Session.Info; user: SessionV1.WithParts }) {
    if (input.user.info.role === "user" && input.user.info.tools?.workflow === false) return true
    const rules = Permission.merge(input.agent.permission, KiloSessionPrompt.guardPermissions(input))
    return Permission.disabled(["workflow"], rules).has("workflow")
  }

  /**
   * Add this turn's ultracode reminder to the last user message (persisted, deduplicated by metadata, so steps of
   * the same turn and later turns keep identical history for the prompt cache). On and off dedupe by the newest
   * state, so a toggle made on, off, then on again within one turn re-asserts on. Config and runtime flags come
   * from the reminder call site; without them (isolated reminder tests) nothing is added.
   */
  export const apply = Effect.fn("KiloUltracode.apply")(function* (input: {
    messages: SessionV1.WithParts[]
    agent: Agent.Info
    session: Session.Info
    user: SessionV1.WithParts
  }) {
    if (!root(input.session)) return
    const config = yield* Effect.serviceOption(Config.Service)
    const flags = yield* Effect.serviceOption(RuntimeFlags.Service)
    if (Option.isNone(config) || Option.isNone(flags)) return
    const cfg = yield* config.value.get()
    if (!KiloWorkflowEnabled.enabled(cfg, flags.value)) return
    if (disabled(input)) return

    const sessions = yield* Session.Service
    // The loop reads the session once per turn; re-read so a toggle made mid-turn applies on the next step.
    const fresh = yield* sessions.get(input.session.id).pipe(Effect.orElseSucceed(() => input.session))
    const kinds = input.user.parts.map(reminder)
    const add = Effect.fn("KiloUltracode.add")(function* (kind: Reminder, text: string) {
      const part = yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: input.user.info.id,
        sessionID: input.user.info.sessionID,
        type: "text",
        text: `\n\n${WorkflowPrompts.wrap(text)}`,
        synthetic: true,
        metadata: { kilo: { reminder: kind } },
      })
      input.user.parts.push(part)
    })

    if (enabled(fresh, cfg, flags.value)) {
      const last = kinds.findLast((kind) => kind === "ultracode" || kind === "ultracode-off")
      if (last !== "ultracode") yield* add("ultracode", WorkflowPrompts.ULTRACODE_ON)
      return
    }
    if (latest(input.messages) === "ultracode") yield* add("ultracode-off", WorkflowPrompts.ULTRACODE_OFF)
    if (cfg.experimental?.ultracode_keyword === false) return
    if (kinds.includes("ultracode-keyword")) return
    if (keyword(input.user.parts)) yield* add("ultracode-keyword", WorkflowPrompts.ULTRACODE_KEYWORD)
  })
}
