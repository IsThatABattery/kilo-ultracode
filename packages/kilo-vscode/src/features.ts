import { hasIndexingPlugin } from "@kilocode/kilo-indexing/detect"
import type { KiloClient } from "@kilocode/sdk/v2"
import * as vscode from "vscode"

type PluginSpec = string | [string, Record<string, unknown>]

type ConfigLike = {
  plugin?: readonly PluginSpec[] | null
}

export type Features = {
  indexing: boolean
  sandboxControls: boolean
  backgroundSubagents: boolean
  speechToText: boolean
  /** The backend runs dynamic workflows, so ultracode and the workflow card are available. */
  workflows: boolean
}

/** Features the backend reports through `GET /experimental/capabilities`. */
export type Capabilities = Pick<Features, "backgroundSubagents" | "workflows">

const NONE: Capabilities = { backgroundSubagents: false, workflows: false }

export function configFeatures(
  config?: ConfigLike | null,
  server: Capabilities = NONE,
  remote = !!vscode.env.remoteName,
): Features {
  return {
    indexing: hasIndexingPlugin(config?.plugin ?? []),
    sandboxControls: process.platform !== "win32",
    backgroundSubagents: server.backgroundSubagents,
    speechToText: !remote,
    workflows: server.workflows,
  }
}

export async function serverFeatures(client: Pick<KiloClient, "experimental">, dir: string): Promise<Capabilities> {
  if (!client.experimental?.capabilities?.get) return NONE
  try {
    const { data } = await client.experimental.capabilities.get({ directory: dir }, { throwOnError: true })
    // Older backends omit `workflows`; treat a missing capability as unavailable.
    return { backgroundSubagents: data?.backgroundSubagents === true, workflows: data?.workflows === true }
  } catch (error) {
    console.warn("[Kilo New] Failed to fetch server capabilities:", error)
    return NONE
  }
}
