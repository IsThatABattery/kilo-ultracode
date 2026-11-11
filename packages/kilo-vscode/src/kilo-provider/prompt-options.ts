/** Prompt fields the webview sends beside the positional ones (model, agent, variant, ...). */
export type PromptOptions = {
  ultracode?: boolean
  /** The user dismissed the `ultracode` keyword in the prompt, so it must not opt this message in. */
  noUltracode?: boolean
}

/** A boolean webview field, or undefined when it is missing or malformed. */
export function flag(value: unknown) {
  return typeof value === "boolean" ? value : undefined
}

/**
 * The `ultracode` request body field. Only an explicit choice is sent; without
 * one the backend keeps the session's stored toggle or the config default.
 */
export function ultracodeField(value: boolean | undefined) {
  return value === undefined ? {} : { ultracode: value }
}

/**
 * Text part metadata for a message whose `ultracode` keyword the user dismissed:
 * `metadata.kilo.noUltracode` tells the backend's keyword detector to skip it.
 */
export function keywordMetadata(metadata: Record<string, unknown> | undefined, dismissed: boolean | undefined) {
  if (!dismissed) return metadata
  const kilo = metadata?.kilo
  return { ...metadata, kilo: { ...(kilo && typeof kilo === "object" ? kilo : {}), noUltracode: true } }
}
