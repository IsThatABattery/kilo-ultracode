// Maps a workflow agent's `effort` option onto the reasoning variant keys a model actually has.
// Variant keys are provider-specific (see ProviderTransform.variants), so an effort is only ever
// translated into one of `keys` or left unset — never synthesized — and an unset variant means the
// provider default applies.

import { preserveVariant } from "@/kilocode/cli/cmd/run/variant"
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
   * Pick the variant key that best matches `effort`, or undefined to use the provider default.
   * - an exact key wins;
   * - `none`/`minimal` are never chosen as stand-ins, since they turn reasoning off;
   * - `{none, thinking}` toggle models get `thinking` for medium and above;
   * - otherwise the nearest ladder key, except that a request at or below medium is never
   *   escalated more than one rung (budget-only `{high, max}` models keep their default instead).
   */
  export function pick(effort: string | undefined, keys: readonly string[]) {
    if (!valid(effort) || keys.length === 0) return undefined
    if (keys.includes(effort)) return effort
    const usable = keys.filter((key) => key !== "none" && key !== "minimal")
    const rank = ladder.indexOf(effort)
    const medium = ladder.indexOf("medium")
    if (usable.includes("thinking") && rank >= medium) return "thinking"
    const hit = preserveVariant(effort, usable)
    if (!hit) return undefined
    if (rank <= medium && ladder.indexOf(hit) - rank > 1) return undefined
    return hit
  }
}
