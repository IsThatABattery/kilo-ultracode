// End to end: a parent turn calls the workflow tool, the run spawns a real child agent against the fake model
// server, and the completion <task-notification> starts a new parent turn.

import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Database } from "@opencode-ai/core/database/database"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { MemoryService } from "@kilocode/kilo-memory/effect/service"
import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Agent } from "../../../src/agent/agent"
import { Config } from "../../../src/config/config"
import { RuntimeFlags } from "../../../src/effect/runtime-flags"
import { EventV2Bridge } from "../../../src/event-v2-bridge"
import { Git } from "../../../src/git"
import { KiloSessions } from "../../../src/kilo-sessions/kilo-sessions"
import { SessionDrain } from "../../../src/kilocode/session/drain"
import { WorkflowPrompts } from "../../../src/kilocode/workflow/prompts"
import { KiloWorkflow } from "../../../src/kilocode/workflow/service"
import { WorkflowSpawn } from "../../../src/kilocode/workflow/spawn"
import { InstanceBootstrap } from "../../../src/project/bootstrap-service"
import { InstanceStore } from "../../../src/project/instance-store"
import { Project } from "../../../src/project/project"
import { Provider } from "../../../src/provider/provider"
import { SessionPrompt } from "../../../src/session/prompt"
import { SessionID } from "../../../src/session/schema"
import { Session } from "../../../src/session/session"
import { SessionStatus } from "../../../src/session/status"
import { SessionSummary } from "../../../src/session/summary"
import { Worktree } from "../../../src/worktree"
import { disposeAllInstances, provideTmpdirServer } from "../../fixture/fixture"
import { pollWithTimeout, testEffect } from "../../lib/effect"
import { TestLLMServer } from "../../lib/llm-server"

afterEach(async () => {
  await disposeAllInstances()
})

const bootstrap = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      SessionPrompt.node,
      Session.node,
      SessionStatus.node,
      Agent.node,
      Config.node,
      Provider.node,
      SessionDrain.node,
      EventV2Bridge.node,
      Git.node,
      Project.node,
      InstanceStore.node,
      Worktree.node,
      KiloWorkflow.node,
      CrossSpawnSpawner.node,
      Database.node,
      SessionProjector.node,
      LayerNode.make({ service: MemoryService.Service, layer: MemoryService.layer, deps: [] }),
      LayerNode.make({ service: TestLLMServer, layer: TestLLMServer.layer, deps: [] }),
    ]),
    [
      [KiloSessions.node, KiloSessions.testLayer],
      [RuntimeFlags.node, RuntimeFlags.layer({})],
      [SessionSummary.node, Layer.mock(SessionSummary.Service)({ summarize: () => Effect.void })],
      [InstanceStore.bootstrapNode, bootstrap],
    ],
  ),
)

const config = (url: string) => ({
  enabled_providers: ["test"],
  provider: {
    test: {
      npm: "@ai-sdk/openai-compatible",
      options: { baseURL: url, apiKey: "test-key" },
      models: { "test-model": { name: "Test", limit: { context: 100000, output: 10000 } } },
    },
  },
  agent: { code: { model: "test/test-model" } },
  permission: { workflow: "allow" as const },
})

type Body = Record<string, unknown>

function text(body: Body) {
  return JSON.stringify(body.messages ?? [])
}

/** Workflow agents carry the subagent system prompt; the parent session does not. */
const child = (hit: { body: Body }) =>
  text(hit.body).includes("You are a subagent spawned by a workflow orchestration script")
const parent = (hit: { body: Body }) => !child(hit)

const SCRIPT = `export const meta = { name: "greet", description: "Greet from a workflow", phases: [{ title: "Ask" }] }
phase("Ask")
const answer = await agent("Say hello", { label: "greeter" })
return { answer }
`

describe("KiloWorkflow end to end", () => {
  it.live(
    "a workflow tool call runs a child agent and notifies the parent session when done",
    () =>
      provideTmpdirServer(
        ({ llm }) =>
          Effect.gen(function* () {
            const prompt = yield* SessionPrompt.Service
            const sessions = yield* Session.Service
            const service = yield* KiloWorkflow.Service
            const root = yield* sessions.create({ title: "Workflow e2e" })

            yield* llm.textMatch(child, "hello from the child")
            yield* llm.toolMatch(parent, "workflow", { script: SCRIPT })
            yield* llm.textMatch(parent, "Launched the workflow.")
            yield* llm.textMatch(parent, "The workflow finished.")

            yield* prompt.prompt({
              sessionID: root.id,
              agent: "code",
              parts: [{ type: "text", text: "Run a workflow that greets me" }],
            })

            const runs = yield* pollWithTimeout(
              service.list(root.id).pipe(Effect.map((items) => (items.length ? items : undefined))),
              "the workflow run was never registered",
              "10 seconds",
            )
            const runID = runs[0].id
            const done = yield* pollWithTimeout(
              Effect.gen(function* () {
                const messages = yield* sessions.messages({ sessionID: root.id })
                const index = messages.findIndex((message) =>
                  message.parts.some(
                    (part) =>
                      part.type === "text" && part.synthetic === true && part.text.includes("<task-notification>"),
                  ),
                )
                if (index === -1) return undefined
                const reply = messages.slice(index + 1).find((message) => message.info.role === "assistant")
                const finished = reply?.parts.some(
                  (part) => part.type === "text" && part.text === "The workflow finished.",
                )
                return finished ? messages : undefined
              }),
              "the parent never reacted to the completion notification",
              "30 seconds",
            )

            const tool = done
              .flatMap((message) => message.parts)
              .find((part) => part.type === "tool" && part.tool === "workflow")
            expect(tool?.type === "tool" && tool.state.status).toBe("completed")
            const output = tool?.type === "tool" && tool.state.status === "completed" ? tool.state.output : ""
            expect(output).toStartWith(`Workflow launched in background. Run ID: ${runID}`)

            const note = done
              .flatMap((message) => message.parts)
              .find((part) => part.type === "text" && part.text.includes("<task-notification>"))
            const body = note?.type === "text" ? note.text : ""
            expect(note).toMatchObject({ synthetic: true, metadata: { background: true } })
            expect(body).toContain(`<task-id>${runID}</task-id>`)
            expect(body).toContain("<status>completed</status>")
            expect(body).toContain('<summary>Dynamic workflow "Greet from a workflow" completed</summary>')
            expect(body).toContain("hello from the child")

            const detail = yield* service.get(runID)
            expect(detail?.status).toBe("completed")
            expect(JSON.parse(detail?.result ?? "null")).toEqual({ answer: "hello from the child" })
            const agentSession = detail?.list[0].sessionID ?? ""
            const spawned = yield* sessions.get(SessionID.make(agentSession))
            expect(spawned.parentID).toBe(root.id)
            expect(spawned.metadata?.[WorkflowSpawn.METADATA]).toMatchObject({ runID, label: "greeter", phase: "Ask" })

            const childRequest = (yield* llm.inputs).find((body) => child({ body }))
            expect(text(childRequest ?? {})).toContain("Say hello")
            expect(JSON.stringify(childRequest)).toContain(WorkflowPrompts.SUBAGENT_TEXT.split("\n")[0])
          }),
        { config },
      ),
    60_000,
  )
})
