/**
 * Webview requests for dynamic workflow runs and the ultracode toggle.
 * No vscode dependency: KiloProvider passes the client, the session directory lookup, and post.
 */

import type { KiloClient } from "@kilocode/sdk/v2/client"
import { getErrorMessage } from "../kilo-provider-utils"
import { toDetail, toRun } from "./workflow-run"

type Ctx = {
  client: KiloClient | null
  /** Backend directory of a session (its worktree in Agent Manager). */
  dir: (sessionID: string) => string
  post: (message: unknown) => void
}

type Message = { type: string; [key: string]: unknown }

const text = (value: unknown) => (typeof value === "string" && value ? value : undefined)

// One ultracode write at a time per session, across panels: the backend reads and writes the session's
// metadata without a lock, so two quick toggles sent at once could land in the wrong order.
const queue = new Map<string, Promise<boolean>>()

async function ultracode(ctx: Ctx, client: KiloClient | null, sessionID: string, enabled: boolean) {
  const prev = queue.get(sessionID) ?? Promise.resolve(true)
  const next = prev.then(() => {
    if (!client) return false
    return client.ultracode
      .set({ sessionID, enabled, directory: ctx.dir(sessionID) }, { throwOnError: true })
      .then(() => true)
      .catch((err: unknown) => {
        console.error("[Kilo New] Failed to set ultracode:", err)
        return false
      })
  })
  queue.set(sessionID, next)
  const ok = await next
  if (queue.get(sessionID) === next) queue.delete(sessionID)
  // Settles the webview's choice: once stored, the session's stored value takes over.
  ctx.post({ type: "ultracodeSaved", sessionID, ok })
}

async function load(ctx: Ctx, client: KiloClient, runID: string, sessionID: string) {
  const result = await client.workflow
    .get({ runID, directory: ctx.dir(sessionID) }, { throwOnError: true })
    .then((res) => ({ run: toDetail(res.data) }))
    .catch((err: unknown) => ({ error: getErrorMessage(err) || "Failed to load workflow run" }))
  ctx.post({ type: "workflowRunLoaded", runID, ...result })
}

async function control(ctx: Ctx, client: KiloClient, message: Message) {
  const runID = text(message.runID)
  const sessionID = text(message.sessionID)
  const action = message.action
  if (!runID || !sessionID || (action !== "stop" && action !== "pause" && action !== "resume")) return
  const directory = ctx.dir(sessionID)
  const id = text(message.agentID)
  try {
    if (id && action === "stop") {
      await client.workflow.agentStop({ runID, agentID: id, directory }, { throwOnError: true })
      await load(ctx, client, runID, sessionID)
      return
    }
    const res = await client.workflow[action]({ runID, directory }, { throwOnError: true })
    ctx.post({ type: "workflowRunUpdated", run: toRun(res.data) })
  } catch (err) {
    console.error(`[Kilo New] Failed to ${action} workflow run:`, err)
    ctx.post({ type: "workflowRunLoaded", runID, error: getErrorMessage(err) || `Failed to ${action} workflow run` })
  }
}

/** Handle a workflow or ultracode webview message. Returns false for any other message. */
export async function routeWorkflowMessage(input: { type: string }, ctx: Ctx): Promise<boolean> {
  const message = input as Message
  if (message.type !== "setUltracode" && message.type !== "requestWorkflowRun" && message.type !== "workflowControl")
    return false
  const client = ctx.client
  if (message.type === "setUltracode") {
    const sessionID = text(message.sessionID)
    if (sessionID && typeof message.enabled === "boolean") await ultracode(ctx, client, sessionID, message.enabled)
    return true
  }
  if (!client) return true
  if (message.type === "requestWorkflowRun") {
    const runID = text(message.runID)
    const sessionID = text(message.sessionID)
    if (runID && sessionID) await load(ctx, client, runID, sessionID)
    return true
  }
  await control(ctx, client, message)
  return true
}
