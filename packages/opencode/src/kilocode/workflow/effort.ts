// Maps a workflow agent's `effort` option onto the reasoning variant keys a model actually has.
// Variant keys are provider-specific (see ProviderTransform.variants), so an effort is only ever
// translated into one of `keys` or left unset — never synthesized — and an unset variant means the
// provider default applies.

import type { Effort } from "./types"

export namespace WorkflowEffort {
  /** Efforts the `agent()` hook accepts, lowest first (Claude Code's effort enum). */
  export const LEVELS: readonly Effort[] = ["low", "medium", "high", "xhigh", "max"]

  /** The full ladder variant keys are ranked on. */
  const ladder = ["none", "minimal", "low", "medium", "high", "xhigh", "max"]

  export function valid(value: unknown): value is Effort {
    return typeof value === "string" && (LEVELS as readonly string[]).includes(value)
  }

  /**
   * Pick the variant key for `effort`, or undefined to use the provider default. Like Claude Code, an
   * unsupported level falls back to the highest supported level at or below it (xhigh runs as high on a
   * model without xhigh); it is never escalated.
   * - an exact key wins;
   * - `none`/`minimal` are never chosen as stand-ins, since they turn reasoning off;
   * - `{none, thinking}` toggle models get `thinking` for medium and above.
   */
  export function pick(effort: string | undefined, keys: readonly string[]) {
    if (!valid(effort) || keys.length === 0) return undefined
    if (keys.includes(effort)) return effort
    const usable = keys.filter((key) => key !== "none" && key !== "minimal")
    const rank = ladder.indexOf(effort)
    if (usable.includes("thinking") && rank >= ladder.indexOf("medium")) return "thinking"
    return usable
      .filter((key) => ladder.includes(key) && ladder.indexOf(key) <= rank)
      .toSorted((a, b) => ladder.indexOf(b) - ladder.indexOf(a))
      .at(0)
  }
}
