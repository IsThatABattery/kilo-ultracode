// End to end through the production HTTP server graph (HttpApiApp.routes): a session turn calls the workflow tool,
// the script fans out over parallel() (one plain-text agent, one schema agent) and a two-stage pipeline(), every
// agent runs as a real child session against the fake model server, and the completion <task-notification> is
// injected into the parent session, which then takes another turn. Asserts on the routes, the notification and the
// persisted run files (journal.jsonl, output.json, run.json, script.js).

import path from "path"
import { afterEach, describe, expect } from "bun:test"
import { Effect } from "effect"
import { HttpClientResponse } from "effect/unstable/http"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { AppLayer } from "../../../src/effect/app-runtime"
import { WorkflowPaths } from "../../../src/kilocode/server/httpapi/groups/workflow"
import { WorkflowJournal } from "../../../src/kilocode/workflow/journal"
import { WorkflowPrompts } from "../../../src/kilocode/workflow/prompts"
import { KiloWorkflow } from "../../../src/kilocode/workflow/service"
import { WorkflowSpawn } from "../../../src/kilocode/workflow/spawn"
import type { RunDetail, RunInfo } from "../../../src/kilocode/workflow/types"
import { SessionPaths } from "../../../src/server/routes/instance/httpapi/groups/session"
import type { Session } from "../../../src/session/session"
import { GlobalBus, type GlobalEvent } from "../../../src/bus/global"
import { disposeAllInstances, tmpdirScoped } from "../../fixture/fixture"
import { pollWithTimeout, testEffect } from "../../lib/effect"
import { reply, TestLLMServer } from "../../lib/llm-server"
import { testProviderConfig } from "../../lib/test-provider"
import { httpApiLayer, requestInDirectory } from "../../server/httpapi-layer"

afterEach(async () => {
  await disposeAllInstances()
})

const it = testEffect(httpApiLayer)
const app = testEffect(AppLayer)

const SCHEMA = {
  type: "object",
  properties: { score: { type: "number" }, verdict: { type: "string" } },
  required: ["score", "verdict"],
}

const SCRIPT = `export const meta = {
  name: "e2e-review",
  description: "Draft, rate and polish",
  phases: [{ title: "Gather" }, { title: "Refine", detail: "polish each item" }],
}
phase("Gather")
const [draft, rating] = await parallel([
  () => agent("Write a haiku about rivers", { label: "draft" }),
  () => agent("Rate the haiku", { label: "rating", schema: ${JSON.stringify(SCHEMA)} }),
])
phase("Refine")
const polished = await pipeline(
  ["alpha", "beta"],
  (prev, item) => agent("Polish " + item, { label: "polish-" + item }),
  (prev, item, index) => ({ item, index, text: prev }),
)
log("rated " + rating.score)
return { draft, rating, polished }
`

type Body = Record<string, unknown>
type Hit = { body: Body }

const messages = (body: Body) => JSON.stringify(body.messages ?? [])
const has = (hit: Hit, value: string) => messages(hit.body).includes(value)
/** Workflow agents carry the workflow subagent system prompt; the parent session never does. */
const child = (hit: Hit) => has(hit, "You are a subagent spawned by a workflow orchestration script")
const parent = (hit: Hit) => !child(hit)
const ask = (value: string) => (hit: Hit) => child(hit) && has(hit, value)
const tools = (body: Body) =>
  Array.isArray(body.tools)
    ? body.tools.map((tool) => (tool as { function?: { name?: string } }).function?.name ?? "")
    : []

function read<T>(response: HttpClientResponse.HttpClientResponse) {
  if (response.status !== 200) {
    return response.text.pipe(Effect.flatMap((text) => Effect.die(new Error(`HTTP ${response.status}: ${text}`))))
  }
  return response.json.pipe(Effect.map((value) => value as T))
}

describe("dynamic workflow end to end", () => {
  // The HTTP server graph is exercised below; the CLI's app layer is a separate graph and must provide the service
  // too (a missing dependency or a layer cycle fails here).
  app.instance("the app layer provides the workflow service", () =>
    Effect.gen(function* () {
      const runs = yield* KiloWorkflow.Service.use((svc) => svc.list())
      expect(runs).toEqual([])
    }),
  )

  it.live(
    "a session turn launches a parallel + pipeline workflow over HTTP and receives its task-notification",
    () =>
      Effect.gen(function* () {
        const llm = yield* TestLLMServer
        const dir = yield* tmpdirScoped({
          git: true,
          config: {
            ...testProviderConfig(llm.url),
            enabled_providers: ["test"],
            permission: { workflow: "allow" },
          },
        })
        const headers = { "content-type": "application/json" }
        // What SSE consumers (TUI, VS Code) receive: workflow.run.updated, tagged with the parent's directory.
        const events: GlobalEvent[] = []
        const listen = (event: GlobalEvent) => {
          if (event.payload?.type === "workflow.run.updated") events.push(event)
        }
        yield* Effect.acquireRelease(
          Effect.sync(() => GlobalBus.on("event", listen)),
          () => Effect.sync(() => GlobalBus.off("event", listen)),
        )
        const call = <T>(route: string, init?: RequestInit) =>
          requestInDirectory(route, dir, { ...init, headers }).pipe(Effect.flatMap(read<T>))

        // Children: answered by their own prompt, whatever order they arrive in.
        yield* llm.textMatch(ask("Write a haiku about rivers"), "Rivers bend to the sea", {
          usage: { input: 11, output: 7 },
        })
        yield* llm.pushMatch(
          ask("Rate the haiku"),
          reply()
            .tool(WorkflowPrompts.STRUCTURED_OUTPUT_TOOL, { score: 8, verdict: "vivid" })
            .usage({ input: 13, output: 5 })
            .item(),
        )
        yield* llm.textMatch(ask("Polish alpha"), "ALPHA", { usage: { input: 3, output: 2 } })
        yield* llm.textMatch(ask("Polish beta"), "BETA", { usage: { input: 3, output: 2 } })
        // Parent: launch, acknowledge the launch, then react to the notification.
        yield* llm.toolMatch((hit) => parent(hit) && !has(hit, "Workflow launched in background"), "workflow", {
          script: SCRIPT,
        })
        yield* llm.textMatch(
          (hit) => parent(hit) && has(hit, "Workflow launched in background") && !has(hit, "<task-notification>"),
          "Launched the workflow.",
        )
        yield* llm.textMatch((hit) => parent(hit) && has(hit, "<task-notification>"), "The workflow finished.")

        const session = yield* call<Session.Info>(SessionPaths.create, {
          method: "POST",
          body: JSON.stringify({ title: "Workflow e2e" }),
        })
        yield* call<SessionV1.WithParts>(SessionPaths.prompt.replace(":sessionID", session.id), {
          method: "POST",
          body: JSON.stringify({
            agent: "code",
            model: { providerID: "test", modelID: "test-model" },
            parts: [{ type: "text", text: "Draft, rate and polish a haiku with a workflow" }],
          }),
        })

        const runs = yield* call<RunInfo[]>(`${WorkflowPaths.list}?sessionID=${session.id}`)
        expect(runs).toHaveLength(1)
        const runID = runs[0].id
        expect(runID).toMatch(/^wf_[0-9a-f]{8}-[0-9a-f]{3}$/)

        // The notification lands in the parent session and starts a turn that answers it.
        const history = yield* pollWithTimeout(
          Effect.gen(function* () {
            const list = yield* call<SessionV1.WithParts[]>(SessionPaths.messages.replace(":sessionID", session.id))
            const index = list.findIndex((message) =>
              message.parts.some((part) => part.type === "text" && part.text.includes("<task-notification>")),
            )
            if (index === -1) return undefined
            const answered = list
              .slice(index + 1)
              .some(
                (message) =>
                  message.info.role === "assistant" &&
                  message.parts.some((part) => part.type === "text" && part.text === "The workflow finished."),
              )
            return answered ? list : undefined
          }),
          "the parent session never answered the workflow's task-notification",
          "45 seconds",
        )

        const parts = history.flatMap((message) => message.parts)
        const launch = parts.find((part) => part.type === "tool" && part.tool === "workflow")
        expect(launch?.type === "tool" && launch.state.status).toBe("completed")
        if (launch?.type !== "tool" || launch.state.status !== "completed") throw new Error("workflow tool missing")
        expect(launch.state.output).toStartWith(`Workflow launched in background. Run ID: ${runID}`)
        expect(launch.state.metadata).toMatchObject({
          runID,
          name: "e2e-review",
          description: "Draft, rate and polish",
        })

        const note = parts.find((part) => part.type === "text" && part.text.includes("<task-notification>"))
        if (note?.type !== "text") throw new Error("notification missing")
        expect(note).toMatchObject({ synthetic: true, metadata: { background: true } })
        expect(note.text).toContain(`<task-id>${runID}</task-id>`)
        expect(note.text).toContain("<status>completed</status>")
        expect(note.text).toContain('<summary>Dynamic workflow "Draft, rate and polish" completed</summary>')
        expect(note.text).toContain(
          "<agent_count>4</agent_count><agents_done>4</agents_done><agents_error>0</agents_error>",
        )
        expect(note.text).toContain("<subagent_tokens>")
        expect(note.text).not.toContain("<subagent_tokens>0</subagent_tokens>")

        const expected = {
          draft: "Rivers bend to the sea",
          rating: { score: 8, verdict: "vivid" },
          polished: [
            { item: "alpha", index: 0, text: "ALPHA" },
            { item: "beta", index: 1, text: "BETA" },
          ],
        }
        const result = /<result>([\s\S]*)<\/result>/.exec(note.text)?.[1] ?? ""
        expect(JSON.parse(result)).toEqual(expected)

        // Run detail over HTTP.
        const detail = yield* call<RunDetail>(WorkflowPaths.get.replace(":runID", runID))
        expect(detail).toMatchObject({ status: "completed", agents: 4, done: 4, error: 0, skipped: 0, cached: 0 })
        expect(detail.ended).toBeGreaterThanOrEqual(detail.started)
        expect(detail.logs).toEqual(["rated 8"])
        expect(detail.phases.map((item) => [item.title, item.total, item.done])).toEqual([
          ["Gather", 2, 2],
          ["Refine", 2, 2],
        ])
        expect(detail.phases[1].detail).toBe("polish each item")
        expect(detail.list.map((item) => [item.label, item.phase, item.status])).toEqual([
          ["draft", "Gather", "completed"],
          ["rating", "Gather", "completed"],
          ["polish-alpha", "Refine", "completed"],
          ["polish-beta", "Refine", "completed"],
        ])
        expect(detail.list.every((item) => item.model === "test/test-model")).toBe(true)

        // Every agent is a tagged child session of the launching session.
        for (const item of detail.list) {
          const spawned = yield* call<Session.Info>(SessionPaths.get.replace(":sessionID", item.sessionID ?? ""))
          expect(spawned.parentID).toBe(session.id)
          expect(spawned.metadata?.[WorkflowSpawn.METADATA]).toMatchObject({
            runID,
            agentID: item.id,
            label: item.label,
            phase: item.phase,
          })
        }

        // The schema agent got the StructuredOutput tool without a forced tool choice; no agent can recurse.
        const inputs = yield* llm.inputs
        const rated = inputs.find((body) => ask("Rate the haiku")({ body }))
        if (!rated) throw new Error("schema agent request missing")
        expect(tools(rated)).toContain(WorkflowPrompts.STRUCTURED_OUTPUT_TOOL)
        expect(rated.tool_choice).not.toBe("required")
        expect(messages(rated)).toContain(WorkflowPrompts.SUBAGENT_STRUCTURED.split("\n")[2])
        for (const body of inputs.filter((body) => child({ body }))) {
          expect(tools(body)).not.toContain("workflow")
          expect(tools(body)).not.toContain("task")
        }

        // Progress events: published while running, with a final completed snapshot (status changes always publish).
        const updates = events
          .filter((event) => event.payload.properties.run.id === runID)
          .map((event) => ({ directory: event.directory, run: event.payload.properties.run as RunInfo }))
        expect(updates.length).toBeGreaterThanOrEqual(2)
        expect(updates.every((item) => item.directory === dir && item.run.sessionID === session.id)).toBe(true)
        expect(updates[0].run.status).toBe("running")
        expect(updates.at(-1)?.run).toMatchObject({ status: "completed", agents: 4, done: 4 })

        // Persisted run files.
        expect(detail.dir).toEndWith(path.join("workflow", session.id, runID))
        expect(yield* Effect.promise(() => Bun.file(path.join(detail.dir, "script.js")).text())).toBe(SCRIPT)

        const journal = (yield* Effect.promise(() => Bun.file(path.join(detail.dir, WorkflowJournal.FILE)).text()))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as WorkflowJournal.Entry)
        expect(journal).toHaveLength(4)
        expect(journal.every((entry) => entry.type === "result" && /^[0-9a-f]{64}$/.test(entry.key))).toBe(true)
        expect(
          journal
            .map((entry) => [entry.index, entry.label, entry.phase, entry.value])
            .toSorted((a, b) => Number(a[0]) - Number(b[0])),
        ).toEqual([
          [0, "draft", "Gather", "Rivers bend to the sea"],
          [1, "rating", "Gather", { score: 8, verdict: "vivid" }],
          [2, "polish-alpha", "Refine", "ALPHA"],
          [3, "polish-beta", "Refine", "BETA"],
        ])
        const keyed = journal.find((entry) => entry.label === "rating")
        expect(keyed?.key).toBe(
          WorkflowJournal.key("Rate the haiku", { label: "rating", phase: "Gather", schema: SCHEMA }),
        )

        const output = yield* Effect.promise(() => Bun.file(path.join(detail.dir, "output.json")).json())
        expect(output).toEqual({
          summary: 'Dynamic workflow "Draft, rate and polish" completed',
          agentCount: 4,
          logs: ["rated 8"],
          result: expected,
        })
        const saved = yield* Effect.promise(() => Bun.file(path.join(detail.dir, "run.json")).json())
        expect(saved).toMatchObject({ id: runID, status: "completed", agents: 4, done: 4 })
        expect(saved.list.map((item: { sessionID?: string }) => item.sessionID)).toEqual(
          detail.list.map((item) => item.sessionID),
        )
      }).pipe(Effect.provide(TestLLMServer.layer), Effect.provide(AppNodeBuilder.build(CrossSpawnSpawner.node))),
    90_000,
  )
})
