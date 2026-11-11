/**
 * Per-scope ultracode toggle (Claude Code's "Ultracode" switch under the effort slider).
 *
 * A scope is a session id or a draft id (the no-session composer, a pending
 * draft). The effective state is the local choice, then the session's stored
 * value (`metadata["kilo.ultracode"].enabled`, recovered through session info
 * so it survives a reload), then the `experimental.ultracode` config default.
 *
 * A real session persists a choice right away through the backend, so turns
 * the webview does not author (workflow results, goal continuations) see it.
 * A draft (including the UUID scope a no-session send mints) or a cloud
 * preview only remembers it locally; the first prompt carries it and the
 * backend stores it on the new session.
 *
 * A local choice only bridges the time until the backend stores it. While a
 * write is in flight the choice wins, so the echo of an earlier quick toggle
 * cannot flip the switch back. Once the host reports the last write stored
 * (`ultracodeSaved`), the stored value takes over. A choice that was never
 * written (a draft's, moved to its session) or whose write failed holds only
 * while the stored value stays the one seen then, so the next prompt carries
 * it; a newer value from another client such as the TUI's `/ultracode` wins.
 */

import { onCleanup, type Accessor } from "solid-js"
import { createStore, produce } from "solid-js/store"
import type { ExtensionMessage } from "../types/messages"

type Message = { type: "setUltracode"; sessionID: string; enabled: boolean }

interface Options {
  session: Accessor<string>
  stored: (sessionID: string) => boolean | undefined
  fallback: Accessor<boolean | undefined>
  available: Accessor<boolean>
  draft: (id: string) => boolean
  post: (message: Message) => void
  /** Host messages, for the `ultracodeSaved` acknowledgements of this module's writes. */
  listen?: (handler: (message: ExtensionMessage) => void) => () => void
}

export function createSessionUltracode(options: Options) {
  // Each choice keeps the stored value it was made against (`base`) and its writes still in flight.
  const [choices, setChoices] = createStore<Record<string, { value: boolean; base?: boolean; pending: number }>>({})
  const scope = (id?: string) => id ?? options.session()
  // Only backend session ids ("ses…") can be stored; drafts include the UUID a no-session send mints.
  const local = (id: string) => options.draft(id) || !id.startsWith("ses")
  const set = (id: string, value: boolean | undefined, base?: boolean, pending = 0) =>
    setChoices(
      produce((map) => {
        if (value === undefined) {
          delete map[id]
          return
        }
        map[id] = { value, base, pending }
      }),
    )

  /** The local choice while it is still newer than the session's stored value. */
  const choice = (sid: string) => {
    const entry = choices[sid]
    if (!entry) return undefined
    if (entry.pending === 0 && options.stored(sid) !== entry.base) return undefined
    return entry.value
  }

  const current = (id?: string) => {
    if (!options.available()) return false
    const sid = scope(id)
    return choice(sid) ?? options.stored(sid) ?? options.fallback() ?? false
  }

  /**
   * The value a prompt carries: only an explicit choice, and only when the
   * backend supports workflows. Without a choice the backend applies the same
   * stored value or config default that current() shows.
   */
  const request = (id?: string) => {
    if (!options.available()) return undefined
    return choice(scope(id))
  }

  /** request() as a prompt-settings fragment: no key at all without a choice. */
  const body = (id?: string): { ultracode?: boolean } => {
    const value = request(id)
    return value === undefined ? {} : { ultracode: value }
  }

  const select = (value: boolean, id?: string) => {
    const sid = scope(id)
    const send = options.available() && !local(sid)
    const pending = (choices[sid]?.pending ?? 0) + (send ? 1 : 0)
    set(sid, value, options.stored(sid), pending)
    if (send) options.post({ type: "setUltracode", sessionID: sid, enabled: value })
  }

  /** The host finished one write for this session; after the last one, the stored value takes over. */
  const saved = (sid: string, ok: boolean) => {
    const entry = choices[sid]
    if (!entry || entry.pending === 0) return
    if (entry.pending > 1) return set(sid, entry.value, entry.base, entry.pending - 1)
    // A stored choice is the backend's now; a failed one waits for the next prompt to carry it.
    if (ok) return set(sid, undefined)
    set(sid, entry.value, options.stored(sid))
  }

  if (options.listen) {
    const stop = options.listen((message) => {
      if (message.type === "ultracodeSaved") saved(message.sessionID, message.ok)
    })
    onCleanup(stop)
  }

  const toggle = (id?: string) => {
    const next = !current(id)
    select(next, id)
    return next
  }

  /** Move a draft's choice to the session it became (or a composer's choice to a fresh draft). */
  const transfer = (from: string, to: string) => {
    const entry = choices[from]
    if (!entry) return
    // Against the target's stored value now, so the backend's echo of the first prompt takes over.
    set(to, entry.value, options.stored(to))
    set(from, undefined)
  }

  const forget = (id: string) => set(id, undefined)

  /** The local choices by scope, stale or not. */
  const selections = () => Object.fromEntries(Object.entries(choices).map(([id, entry]) => [id, entry.value]))

  return { selections, current, request, body, select, saved, toggle, transfer, forget }
}

/** What chat surfaces read and change; drafts and transfers stay inside the session context. */
export type SessionUltracode = Pick<ReturnType<typeof createSessionUltracode>, "current" | "select" | "toggle">
