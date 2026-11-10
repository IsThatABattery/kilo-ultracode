import type { Size } from "./types"

type Settings = { experimental?: { workflows?: boolean; ultracode?: boolean; workflow_size?: Size } }
type Flags = { disableWorkflows: boolean }

export namespace KiloWorkflowEnabled {
  /** Dynamic workflows are on by default; `experimental.workflows: false` or KILO_DISABLE_WORKFLOWS=1 turns them off. */
  export function enabled(cfg: Settings, flags: Flags) {
    if (flags.disableWorkflows) return false
    return cfg.experimental?.workflows !== false
  }

  /** Default ultracode state for sessions that never toggled it. */
  export function ultracode(cfg: Settings) {
    return cfg.experimental?.ultracode === true
  }

  /** Advisory size guideline; `explicit` is false when the default applies. */
  export function size(cfg: Settings): { size: Size; explicit: boolean } {
    const value = cfg.experimental?.workflow_size
    if (value) return { size: value, explicit: true }
    return { size: "medium", explicit: false }
  }

  /** Agent count each size guideline aims below. */
  export const LIMITS: Record<Exclude<Size, "unrestricted">, number> = { small: 5, medium: 10, large: 50 }
}
