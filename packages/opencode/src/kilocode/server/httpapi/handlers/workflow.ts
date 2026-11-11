import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { InstanceHttpApi } from "@/server/routes/instance/httpapi/api"
import { SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { KiloWorkflowEnabled } from "@/kilocode/workflow/enabled"
import { KiloWorkflow } from "@/kilocode/workflow/service"
import { KiloUltracode } from "@/kilocode/workflow/ultracode"
import { Effect, Layer } from "effect"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import { WorkflowSaveError } from "../groups/workflow"

const missing = () => new HttpApiError.NotFound({})

const workflow = HttpApiBuilder.group(InstanceHttpApi, "workflow", (handlers) =>
  Effect.gen(function* () {
    const runs = yield* KiloWorkflow.Service

    const list = Effect.fn("WorkflowHttpApi.list")(function* (ctx: { query: { sessionID?: SessionID } }) {
      return yield* runs.list(ctx.query.sessionID)
    })

    const get = Effect.fn("WorkflowHttpApi.get")(function* (ctx: { params: { runID: string } }) {
      const detail = yield* runs.get(ctx.params.runID)
      if (!detail) return yield* missing()
      return detail
    })

    const control = (name: string, act: (runID: string) => ReturnType<KiloWorkflow.Interface["stop"]>) =>
      Effect.fn(`WorkflowHttpApi.${name}`)(function* (ctx: { params: { runID: string } }) {
        const info = yield* act(ctx.params.runID)
        if (!info) return yield* missing()
        return info
      })

    const agentStop = Effect.fn("WorkflowHttpApi.agentStop")(function* (ctx: {
      params: { runID: string; agentID: string }
    }) {
      const stopped = yield* runs.stopAgent(ctx.params.runID, ctx.params.agentID)
      if (!stopped) return yield* missing()
      return true
    })

    const save = Effect.fn("WorkflowHttpApi.save")(function* (ctx: {
      params: { runID: string }
      payload: { scope: "project" | "global" }
    }) {
      const file = yield* runs
        .save(ctx.params.runID, { scope: ctx.payload.scope })
        .pipe(Effect.mapError((err) => new WorkflowSaveError({ message: err.message })))
      if (!file) return yield* missing()
      return { path: file }
    })

    return handlers
      .handle("list", list)
      .handle("get", get)
      .handle("stop", control("stop", runs.stop))
      .handle("pause", control("pause", runs.pause))
      .handle("resume", control("resume", runs.resume))
      .handle("agentStop", agentStop)
      .handle("save", save)
  }),
)

const ultracode = HttpApiBuilder.group(InstanceHttpApi, "ultracode", (handlers) =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const config = yield* Config.Service
    const flags = yield* RuntimeFlags.Service

    const get = Effect.fn("UltracodeHttpApi.get")(function* (ctx: { query: { sessionID: SessionID } }) {
      const session = yield* sessions.get(ctx.query.sessionID).pipe(Effect.catch(() => Effect.succeed(undefined)))
      if (!session) return yield* missing()
      const cfg = yield* config.get()
      return {
        enabled: KiloUltracode.enabled(session, cfg, flags),
        available: KiloWorkflowEnabled.enabled(cfg, flags),
        size: KiloWorkflowEnabled.size(cfg).size,
      }
    })

    const set = Effect.fn("UltracodeHttpApi.set")(function* (ctx: {
      payload: { sessionID: SessionID; enabled: boolean }
    }) {
      const session = yield* sessions.get(ctx.payload.sessionID).pipe(Effect.catch(() => Effect.succeed(undefined)))
      if (!session) return yield* missing()
      yield* KiloUltracode.set(ctx.payload.sessionID, ctx.payload.enabled).pipe(
        Effect.provideService(Session.Service, sessions),
        Effect.catch(() => missing()),
      )
      return { enabled: ctx.payload.enabled }
    })

    return handlers.handle("get", get).handle("set", set)
  }),
)

export const workflowHandlers = Layer.mergeAll(workflow, ultracode)
