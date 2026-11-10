export namespace KiloUltracode {
  /** Session metadata key: `{ enabled: boolean }`. */
  export const KEY = "kilo.ultracode"

  export function read(metadata: Record<string, unknown> | undefined): { enabled?: boolean } {
    const value = metadata?.[KEY]
    if (!value || typeof value !== "object") return {}
    const enabled = (value as { enabled?: unknown }).enabled
    return typeof enabled === "boolean" ? { enabled } : {}
  }
}
