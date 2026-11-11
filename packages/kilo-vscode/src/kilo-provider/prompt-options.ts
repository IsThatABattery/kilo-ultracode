/** Prompt fields the webview sends beside the positional ones (model, agent, variant, ...). */
export type PromptOptions = { ultracode?: boolean }

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
