// The `ultracode` keyword in the prompt, as in Claude Code: the keyword is highlighted while it would opt the turn in to
// a workflow, and Alt+W (Option+W) or backspace right after a highlighted keyword dismisses it for that prompt. A
// dismissed prompt's text part carries `metadata.kilo.noUltracode` so the server does not treat it as an opt-in.

import type { RGBA, SyntaxStyle, TextareaRenderable } from "@opentui/core"
import { createEffect, createSignal, on } from "solid-js"
import { useBindings } from "../keymap"
import { promptOffsetWidth } from "../prompt/display"

const KEYWORD = /\bultracode\b/gi
const STYLE = "extmark.ultracode"
const TYPE = "ultracode-keyword"

export namespace UltracodeKeyword {
  /** Metadata flag under `metadata.kilo` that tells the server's keyword detector to ignore the part. */
  export const DISMISSED = "noUltracode"

  const [enabled, setEnabled] = createSignal(false)

  /** Whether the server runs dynamic workflows, as the workflows plugin last saw; the keyword is inert otherwise. */
  export const available = enabled

  export function report(value: boolean) {
    setEnabled(value)
  }

  /**
   * Prompt display-offset ranges of each keyword the server would honor. Text that is itself a slash command never
   * counts, matching the server's detector.
   */
  export function ranges(text: string) {
    if (text.trimStart().startsWith("/")) return []
    return [...text.matchAll(KEYWORD)].map((match) => {
      const start = promptOffsetWidth(text.slice(0, match.index))
      return { start, end: start + promptOffsetWidth(match[0]) }
    })
  }

  /** A submitted text part, flagged when the user dismissed its keyword. */
  export function stamp<T extends { metadata?: Record<string, unknown> }>(part: T, dismissed: boolean): T {
    if (!dismissed) return part
    const kilo = part.metadata?.kilo
    const base = kilo && typeof kilo === "object" ? kilo : {}
    return { ...part, metadata: { ...part.metadata, kilo: { ...base, [DISMISSED]: true } } }
  }

  /**
   * Keyword highlighting for one prompt textarea; `mark()` runs on every content change. While a keyword is shown,
   * Alt+W dismisses it, and so does backspace with the cursor right after it (bound on the focused textarea, ahead
   * of the managed input layer, like the prompt's own shell-mode backspace). `tick` changes on cursor moves.
   */
  export function create(opts: {
    input: () => TextareaRenderable | undefined
    target: () => TextareaRenderable | undefined
    tick: () => unknown
    syntax: () => SyntaxStyle
    color: () => RGBA
    active: () => boolean
  }) {
    const [dismissed, setDismissed] = createSignal(false)
    const [ends, setEnds] = createSignal<number[]>([])

    function dismiss() {
      setDismissed(true)
      mark()
    }

    function mark() {
      const input = opts.input()
      if (!input || input.isDestroyed) return
      const type = input.extmarks.getTypeId(TYPE) ?? input.extmarks.registerType(TYPE)
      const stale = input.extmarks.getAllForTypeId(type)
      for (const item of stale) input.extmarks.delete(item.id)
      const found = ranges(input.plainText)
      // Dismissal lasts for this prompt: it ends once the keyword is gone (submitted, cleared or deleted).
      if (found.length === 0) setDismissed(false)
      const shown = found.length > 0 && !dismissed() && opts.active()
      setEnds(shown ? found.map((range) => range.end) : [])
      if (shown) {
        const syntax = opts.syntax()
        const style = syntax.getStyleId(STYLE) ?? syntax.registerStyle(STYLE, { fg: opts.color(), bold: true })
        for (const range of found) input.extmarks.create({ ...range, styleId: style, typeId: type })
      }
      // Highlights changed without a content change (dismissal, toggled availability): redraw.
      if (shown || stale.length > 0) input.requestRender()
    }

    createEffect(on(opts.active, () => mark(), { defer: true }))

    useBindings(() => {
      opts.tick()
      const after = ends().includes(opts.input()?.cursorOffset ?? -1)
      return {
        target: opts.target,
        enabled: opts.target() !== undefined && ends().length > 0,
        bindings: [
          { key: "alt+w", desc: "Dismiss the ultracode keyword", group: "Prompt", cmd: dismiss },
          ...(after
            ? [{ key: "backspace", desc: "Dismiss the ultracode keyword", group: "Prompt", cmd: dismiss }]
            : []),
        ],
      }
    })

    return {
      mark,
      dismissed,
      stamp<T extends { metadata?: Record<string, unknown> }>(part: T) {
        return stamp(part, dismissed())
      },
    }
  }
}
