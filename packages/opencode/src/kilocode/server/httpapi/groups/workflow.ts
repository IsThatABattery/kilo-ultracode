import { SessionID } from "@/session/schema"
import { WorkflowEvent } from "@opencode-ai/schema/kilocode/workflow-event"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "@/server/routes/instance/httpapi/middleware/authorization"
import { InstanceContextMiddleware } from "@/server/routes/instance/httpapi/middleware/instance-context"
import {
  WorkspaceRoutingMiddleware,
  WorkspaceRoutingQuery,
  WorkspaceRoutingQueryFields,
} from "@/server/routes/instance/httpapi/middleware/workspace-routing"
import { described } from "@/server/routes/instance/httpapi/groups/metadata"

const root = "/kilocode/workflow"

export const WorkflowPaths = {
  list: root,
  get: `${root}/:runID`,
  stop: `${root}/:runID/stop`,
  pause: `${root}/:runID/pause`,
  resume: `${root}/:runID/resume`,
  agentStop: `${root}/:runID/agent/:agentID/stop`,
  save: `${root}/:runID/save`,
  ultracode: "/kilocode/ultracode",
} as const

export const WorkflowListQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  sessionID: Schema.optional(SessionID),
})

export const UltracodeQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  sessionID: SessionID,
})

export const WorkflowSavePayload = Schema.Struct({
  scope: Schema.Literals(["project", "global"]),
})

export const WorkflowSaved = Schema.Struct({ path: Schema.String }).annotate({ identifier: "WorkflowSaved" })

export const UltracodeState = Schema.Struct({
  /** Effective state for the session: its toggle, else the `experimental.ultracode` default. */
  enabled: Schema.Boolean,
  /** Dynamic workflows are enabled, so ultracode can be turned on. */
  available: Schema.Boolean,
  size: WorkflowEvent.Size,
}).annotate({ identifier: "UltracodeState" })

export const UltracodePayload = Schema.Struct({
  sessionID: SessionID,
  enabled: Schema.Boolean,
})

export const UltracodeSet = Schema.Struct({ enabled: Schema.Boolean }).annotate({ identifier: "UltracodeSet" })

export class WorkflowSaveError extends Schema.ErrorClass<WorkflowSaveError>("WorkflowSaveError")(
  { message: Schema.String },
  { httpApiStatus: 422 },
) {}

const runParams = { runID: Schema.String }

export const WorkflowApi = HttpApi.make("workflow")
  .add(
    HttpApiGroup.make("workflow")
      .add(
        HttpApiEndpoint.get("list", WorkflowPaths.list, {
          query: WorkflowListQuery,
          success: described(Schema.Array(WorkflowEvent.RunInfo), "Workflow runs"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "workflow.list",
            summary: "List workflow runs",
            description: "List dynamic workflow runs of the routed directory, optionally for one launching session.",
          }),
        ),
        HttpApiEndpoint.get("get", WorkflowPaths.get, {
          params: runParams,
          query: WorkspaceRoutingQuery,
          success: described(WorkflowEvent.RunDetail, "Workflow run detail"),
          error: HttpApiError.NotFound,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "workflow.get",
            summary: "Get workflow run",
            description: "Get one workflow run with its agents, narrator logs and result.",
          }),
        ),
        HttpApiEndpoint.post("stop", WorkflowPaths.stop, {
          params: runParams,
          query: WorkspaceRoutingQuery,
          success: described(WorkflowEvent.RunInfo, "Stopped workflow run"),
          error: HttpApiError.NotFound,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "workflow.stop",
            summary: "Stop workflow run",
            description: "Stop a workflow run: running agents are cancelled and the script is terminated.",
          }),
        ),
        HttpApiEndpoint.post("pause", WorkflowPaths.pause, {
          params: runParams,
          query: WorkspaceRoutingQuery,
          success: described(WorkflowEvent.RunInfo, "Paused workflow run"),
          error: HttpApiError.NotFound,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "workflow.pause",
            summary: "Pause workflow run",
            description: "Pause a workflow run: running agents finish, but no new agents start until it is resumed.",
          }),
        ),
        HttpApiEndpoint.post("resume", WorkflowPaths.resume, {
          params: runParams,
          query: WorkspaceRoutingQuery,
          success: described(WorkflowEvent.RunInfo, "Resumed workflow run"),
          error: HttpApiError.NotFound,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "workflow.resume",
            summary: "Resume workflow run",
            description: "Resume a paused workflow run.",
          }),
        ),
        HttpApiEndpoint.post("agentStop", WorkflowPaths.agentStop, {
          params: { ...runParams, agentID: Schema.String },
          query: WorkspaceRoutingQuery,
          success: described(Schema.Boolean, "Workflow agent stopped"),
          error: HttpApiError.NotFound,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "workflow.agentStop",
            summary: "Stop workflow agent",
            description: "Stop one running or queued agent of a workflow run; the script receives null for it.",
          }),
        ),
        HttpApiEndpoint.post("save", WorkflowPaths.save, {
          params: runParams,
          query: WorkspaceRoutingQuery,
          payload: WorkflowSavePayload,
          success: described(WorkflowSaved, "Saved workflow file"),
          error: [HttpApiError.NotFound, WorkflowSaveError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "workflow.save",
            summary: "Save workflow",
            description:
              "Save a run's script as a saved workflow in the project's .kilo/workflows/ or the global workflows directory.",
          }),
        ),
      )
      .annotateMerge(OpenApi.annotations({ title: "workflow", description: "Kilo dynamic workflow routes." }))
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .add(
    HttpApiGroup.make("ultracode")
      .add(
        HttpApiEndpoint.get("get", WorkflowPaths.ultracode, {
          query: UltracodeQuery,
          success: described(UltracodeState, "Ultracode state"),
          error: HttpApiError.NotFound,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "ultracode.get",
            summary: "Get ultracode state",
            description: "Get whether ultracode is on for a session, whether it is available, and the size guideline.",
          }),
        ),
        HttpApiEndpoint.post("set", WorkflowPaths.ultracode, {
          query: WorkspaceRoutingQuery,
          payload: UltracodePayload,
          success: described(UltracodeSet, "Ultracode state"),
          error: HttpApiError.NotFound,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "ultracode.set",
            summary: "Set ultracode",
            description: "Turn ultracode on or off for a session.",
          }),
        ),
      )
      .annotateMerge(OpenApi.annotations({ title: "ultracode", description: "Kilo ultracode routes." }))
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "kilo HttpApi",
      version: "0.0.1",
      description: "Kilo HttpApi surface.",
    }),
  )
