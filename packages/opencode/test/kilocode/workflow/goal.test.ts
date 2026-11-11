// A workflow launched by an active goal: its agents run outside the goal (the unbound `raw` prompt op), so an agent
// whose turns end in errors (here: structured output never provided) neither errors nor pauses the goal, while the
// completion notification still belongs to the goal's cycle and the root worker reports from it.

import { afterEach, describe, expect } from "bun:test"
import { Effect } from "effect"
import { HttpClientResponse } from "effect/unstable/http"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { WorkflowPaths } from "../../../src/kilocode/server/httpapi/groups/workflow"
import { GoalState } from "../../../src/kilocode/session/goal/state"
import type { RunDetail, RunInfo } from "../../../src/kilocode/workflow/types"
import { SessionPaths } from "../../../src/server/routes/instance/httpapi/groups/session"
import type { Session } from "../../../src/session/session"
import { disposeAllInstances, tmpdirScoped } from "../../fixture/fixture"
import { pollWithTimeout, testEffect } from "../../lib/effect"
import { reply, TestLLMServer } from "../../lib/llm-server"
import { testProviderConfig } from "../../lib/test-provider"
import { httpApiLayer, requestInDirectory } from "../../server/httpapi-layer"

afterEach(async () => {
  await disposeAllInstances()
})

const it = testEffect(httpApiLayer)

const SCRIPT = `export const meta = { name: "goal-check", description: "Check with one failing agent" }
let failed = false
try {
  await agent("Inspect the failing step", {
    label: "failing",
    schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
  })
} catch {
  failed = true
}
return { failed }
`

type Body = Record<string, unknown>
type Hit = { body: Body }

const has = (hit: Hit, value: string) => JSON.stringify(hit.body.messages ?? []).includes(value)
const child = (hit: Hit) => has(hit, "You are a subagent spawned by a workflow orchestration script")
const parent = (hit: Hit) => !child(hit)

function read<T>(response: HttpClientResponse.HttpClientResponse) {
  if (response.status !== 200) {
    return response.text.pipe(Effect.flatMap((text) => Effect.die(new Error(`HTTP ${response.status}: ${text}`))))
  }
  return response.json.pipe(Effect.map((value) => value as T))
}

describe("dynamic workflows under an active goal", () => {
  it.live(
    "a failing workflow agent does not error the goal; the root reports from the notification turn",
    () =>
      Effect.gen(function* () {
        const llm = yield* TestLLMServer
        const dir = yield* tmpdirScoped({
          git: true,
          config: { ...testProviderConfig(llm.url), enabled_providers: ["test"], permission: { workflow: "allow" } },
        })
        const headers = { "content-type": "application/json" }
        const call = <T>(route: string, init?: RequestInit) =>
          requestInDirectory(route, dir, { ...init, headers }).pipe(Effect.flatMap(read<T>))

        // Every attempt of the schema agent ends without StructuredOutput: each turn records a StructuredOutputError,
        // then agent() throws and the script carries on. The first answer waits until the goal's own turn finished,
        // so the notification cannot arrive while that turn is still running (it would preempt the turn).
        const gate = Promise.withResolvers<void>()
        yield* Effect.addFinalizer(() => Effect.sync(() => gate.resolve()))
        yield* llm.pushMatch(
          child,
          reply().wait(gate.promise).text("No structured answer.").stop(),
          ...Array.from({ length: 4 }, () => reply().text("Still no structured answer.").stop()),
        )
        yield* llm.toolMatch((hit) => parent(hit) && !has(hit, "Workflow launched in background"), "workflow", {
          script: SCRIPT,
        })
        yield* llm.textMatch(
          (hit) => parent(hit) && has(hit, "Workflow launched in background") && !has(hit, "<task-notification>"),
          "Launched the workflow.",
        )
        yield* llm.pushMatch(
          (hit) => parent(hit) && has(hit, "<task-notification>"),
          reply().tool("goal_report", { status: "complete", reason: "The workflow finished its check." }),
          reply().text("Goal complete.").stop(),
        )

        const session = yield* call<Session.Info>(SessionPaths.create, {
          method: "POST",
          body: JSON.stringify({ title: "Workflow goal" }),
        })
        yield* call<unknown>(SessionPaths.command.replace(":sessionID", session.id), {
          method: "POST",
          body: JSON.stringify({
            command: "goal",
            arguments: "Check the workspace with a workflow",
            agent: "code",
            model: "test/test-model",
          }),
        })

        const messages = SessionPaths.messages.replace(":sessionID", session.id)
        yield* pollWithTimeout(
          call<SessionV1.WithParts[]>(messages).pipe(
            Effect.map((list) =>
              list.some(
                (message) =>
                  message.info.role === "assistant" &&
                  message.info.finish === "stop" &&
                  message.info.time.completed !== undefined &&
                  message.parts.some((part) => part.type === "text" && part.text === "Launched the workflow."),
              )
                ? true
                : undefined,
            ),
          ),
          "the goal turn never finished launching the workflow",
          "30 seconds",
        )
        gate.resolve()

        const goal = yield* pollWithTimeout(
          Effect.gen(function* () {
            const info = yield* call<Session.Info>(SessionPaths.get.replace(":sessionID", session.id))
            const state = GoalState.read(info.metadata)
            return state?.active === false ? state : undefined
          }),
          "the goal never settled",
          "45 seconds",
        )

        const runs = yield* call<RunInfo[]>(`${WorkflowPaths.list}?sessionID=${session.id}`)
        expect(runs).toHaveLength(1)
        const detail = yield* call<RunDetail>(WorkflowPaths.get.replace(":runID", runs[0].id))
        expect(detail).toMatchObject({ status: "completed", agents: 1, error: 1 })
        expect(detail.list.map((item) => item.status)).toEqual(["error"])
        expect(detail.list[0].error).toContain("StructuredOutput failed validation after 5 attempts")
        expect((yield* llm.hits).filter(child)).toHaveLength(5)
        // Bound to the goal, those errors would have paused it ("Work failed").
        expect(goal).toMatchObject({ status: "complete", active: false })
        expect(goal.reason).toContain("The workflow finished its check.")
      }).pipe(Effect.provide(TestLLMServer.layer), Effect.provide(AppNodeBuilder.build(CrossSpawnSpawner.node))),
    90_000,
  )
})
