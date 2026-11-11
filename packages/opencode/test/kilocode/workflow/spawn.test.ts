import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Database } from "@opencode-ai/core/database/database"
import { Global } from "@opencode-ai/core/global"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { MemoryService } from "@kilocode/kilo-memory/effect/service"
import { afterEach, describe, expect } from "bun:test"
import { $ } from "bun"
import { Effect, Fiber, Layer } from "effect"
import { existsSync } from "fs"
import path from "path"
import { Agent } from "../../../src/agent/agent"
import { Config } from "../../../src/config/config"
import { RuntimeFlags } from "../../../src/effect/runtime-flags"
import { Git } from "../../../src/git"
import { KiloSessions } from "../../../src/kilo-sessions/kilo-sessions"
import { SessionDrain } from "../../../src/kilocode/session/drain"
import { WorkflowPrompts } from "../../../src/kilocode/workflow/prompts"
import { WorkflowSpawn } from "../../../src/kilocode/workflow/spawn"
import type { AgentOpts, Outcome } from "../../../src/kilocode/workflow/types"
import { InstanceBootstrap } from "../../../src/project/bootstrap-service"
import { InstanceStore } from "../../../src/project/instance-store"
import { Project } from "../../../src/project/project"
import { Provider } from "../../../src/provider/provider"
import { SessionPrompt } from "../../../src/session/prompt"
import { SessionID } from "../../../src/session/schema"
import { Session } from "../../../src/session/session"
import { SessionStatus } from "../../../src/session/status"
import { SessionSummary } from "../../../src/session/summary"
import type { TaskPromptOps } from "../../../src/tool/task"
import { Worktree } from "../../../src/worktree"
import { provideTmpdirServer } from "../../fixture/fixture"
import { awaitWithTimeout, pollWithTimeout, testEffect } from "../../lib/effect"
import { reply, TestLLMServer } from "../../lib/llm-server"

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
      Git.node,
      Project.node,
      InstanceStore.node,
      Worktree.node,
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
      models: {
        "test-model": {
          name: "Test",
          reasoning: true,
          limit: { context: 100000, output: 10000 },
          variants: { low: { reasoningEffort: "low" }, high: { reasoningEffort: "high" } },
        },
      },
    },
  },
  agent: { code: { model: "test/test-model" } },
})

const person = {
  type: "object",
  properties: { name: { type: "string" }, age: { type: "integer" } },
  required: ["name"],
}

type Body = Record<string, unknown>

/** The system prompt the provider received in an openai-compatible chat request. */
function system(body: Body) {
  const messages = Array.isArray(body.messages) ? (body.messages as Array<{ role?: string; content?: unknown }>) : []
  return messages
    .filter((message) => message.role === "system")
    .map((message) => (typeof message.content === "string" ? message.content : JSON.stringify(message.content)))
    .join("\n")
}

function tools(body: Body) {
  const list = Array.isArray(body.tools) ? (body.tools as Array<{ function?: { name?: string } }>) : []
  return list.map((tool) => tool.function?.name).filter((name): name is string => typeof name === "string")
}

/** A launched parent turn plus a spawn function bound to it, as the workflow runtime would hold them. */
const setup = (variant?: string) =>
  Effect.gen(function* () {
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const llm = yield* TestLLMServer
    const parent = yield* sessions.create({ title: "Workflow parent" })
    yield* llm.text("Launching the workflow")
    const turn = yield* prompt.prompt({
      sessionID: parent.id,
      agent: "code",
      ...(variant ? { variant } : {}),
      parts: [{ type: "text", text: "Run a workflow" }],
    })
    const ops: TaskPromptOps = {
      cancel: (id) => prompt.cancel(id),
      resolvePromptParts: (template) => prompt.resolvePromptParts(template),
      prompt: (input) => prompt.prompt(input).pipe(Effect.orDie),
    }
    const spawn = yield* WorkflowSpawn.make
    const seen = (yield* llm.inputs).length
    let index = 0
    const run = (
      text: string,
      opts: AgentOpts = {},
      onSession?: (id: string) => void,
      extra: { caller?: string; ops?: TaskPromptOps } = {},
    ) =>
      spawn({
        parent: { sessionID: parent.id, messageID: turn.info.id, agent: extra.caller ?? "code" },
        ops: extra.ops ?? ops,
        run: { id: "wf_0123abcd-abc", name: "test" },
        agent: { id: `agent-${index}`, index: index++, label: opts.label ?? `agent ${index}`, prompt: text, opts },
        onSession,
      })
    /** Provider requests made after the parent turn, i.e. by workflow agents. */
    const requests = llm.inputs.pipe(Effect.map((items) => items.slice(seen)))
    return { parent, turn, ops, run, requests, prompt, sessions, llm }
  })

function completed(outcome: Outcome) {
  if (outcome.status !== "completed") throw new Error(`expected completed, got ${JSON.stringify(outcome)}`)
  return outcome
}

function errored(outcome: Outcome) {
  if (outcome.status !== "error") throw new Error(`expected error, got ${JSON.stringify(outcome)}`)
  return outcome
}

describe("WorkflowSpawn", () => {
  afterEach(() => {
    delete process.env.KILO_MAX_STRUCTURED_OUTPUT_RETRIES
  })

  it.live(
    "returns the agent's final text from a tagged child session of the launching session",
    () =>
      provideTmpdirServer(
        () =>
          Effect.gen(function* () {
            const ctx = yield* setup()
            yield* ctx.llm.push(reply().text("42 files").usage({ input: 120, output: 7 }).stop())
            const sessions: string[] = []
            const outcome = completed(
              yield* ctx.run("Count the files", { label: "counter", phase: "Scan" }, (id) => sessions.push(id)),
            )

            expect(outcome.value).toBe("42 files")
            expect(outcome.model).toEqual({ providerID: "test", modelID: "test-model" })
            expect(outcome.tokens.input).toBe(120)
            expect(outcome.tokens.output).toBe(7)
            expect(outcome.tokens.total).toBeGreaterThanOrEqual(127)
            expect(outcome.tools).toBe(0)
            expect(sessions).toEqual([outcome.sessionID])

            const child = yield* ctx.sessions.get(SessionID.make(outcome.sessionID))
            expect(child.parentID).toBe(ctx.parent.id)
            expect(child.title).toBe("counter (@workflow-subagent subagent)")
            expect(child.agent).toBe("workflow-subagent")
            expect(child.metadata?.[WorkflowSpawn.METADATA]).toEqual({
              runID: "wf_0123abcd-abc",
              agentID: "agent-0",
              index: 0,
              label: "counter",
              phase: "Scan",
            })
            for (const permission of ["task", "question", "workflow"]) {
              expect(child.permission).toContainEqual({ permission, pattern: "*", action: "deny" })
            }
            // Run scripts and journals belong to the launching session, not to its agents.
            expect(child.permission).toContainEqual({
              permission: "external_directory",
              pattern: path.join(Global.Path.data, "workflow", "*"),
              action: "deny",
            })

            const [request] = yield* ctx.requests
            expect(system(request)).toContain(WorkflowPrompts.SUBAGENT_TEXT)
            expect(tools(request)).not.toContain("task")
            expect(tools(request)).not.toContain("question")
            expect(tools(request)).not.toContain("workflow")
            expect(tools(request)).not.toContain(WorkflowPrompts.STRUCTURED_OUTPUT_TOOL)
          }),
        { config },
      ),
    60_000,
  )

  it.live(
    "re-prompts until StructuredOutput passes local validation, without forcing the tool choice",
    () =>
      provideTmpdirServer(
        () =>
          Effect.gen(function* () {
            const ctx = yield* setup()
            yield* ctx.llm.tool(WorkflowPrompts.STRUCTURED_OUTPUT_TOOL, { name: 42 })
            yield* ctx.llm.tool(WorkflowPrompts.STRUCTURED_OUTPUT_TOOL, { name: "Ada", age: 36 })
            const outcome = completed(yield* ctx.run("Describe Ada", { schema: person }))

            expect(outcome.value).toEqual({ name: "Ada", age: 36 })
            expect(outcome.tools).toBe(2)

            const requests = yield* ctx.requests
            expect(requests).toHaveLength(2)
            for (const request of requests) {
              expect(tools(request)).toContain(WorkflowPrompts.STRUCTURED_OUTPUT_TOOL)
              expect(system(request)).toContain(WorkflowPrompts.SUBAGENT_STRUCTURED)
              expect(request.tool_choice).not.toBe("required")
            }
            const retry = JSON.stringify(requests.at(-1))
            expect(retry).toContain("Your final answer did not pass validation: /name must be string")

            const users = (yield* ctx.sessions.messages({ sessionID: SessionID.make(outcome.sessionID) })).filter(
              (message) => message.info.role === "user",
            )
            expect(users).toHaveLength(2)
            for (const user of users) {
              expect(user.info.role === "user" && user.info.format?.type).toBe("json_schema")
            }
          }),
        { config },
      ),
    60_000,
  )

  it.live(
    "gives up after the attempt limit with a non-terminal error",
    () =>
      provideTmpdirServer(
        () =>
          Effect.gen(function* () {
            process.env.KILO_MAX_STRUCTURED_OUTPUT_RETRIES = "2"
            const ctx = yield* setup()
            yield* ctx.llm.text("Ada is a person")
            yield* ctx.llm.text("Still prose")
            const outcome = errored(yield* ctx.run("Describe Ada", { schema: person }))

            expect(outcome.terminal).toBe(false)
            expect(outcome.error).toBe(
              "StructuredOutput failed validation after 2 attempts: the StructuredOutput tool was not called",
            )
            expect(outcome.sessionID).toBeDefined()
            expect(yield* ctx.requests).toHaveLength(2)
          }),
        { config },
      ),
    60_000,
  )

  it.live(
    "reports provider failures as terminal errors",
    () =>
      provideTmpdirServer(
        () =>
          Effect.gen(function* () {
            const ctx = yield* setup()
            yield* ctx.llm.error(400, { error: { message: "bad request: model exploded" } })
            const outcome = errored(yield* ctx.run("Do something"))

            expect(outcome.terminal).toBe(true)
            expect(outcome.error).toContain("model exploded")
            expect(outcome.sessionID).toBeDefined()
          }),
        { config },
      ),
    60_000,
  )

  it.live(
    "maps effort onto the model's own variants and falls back from an unavailable model",
    () =>
      provideTmpdirServer(
        () =>
          Effect.gen(function* () {
            const ctx = yield* setup()
            const high = completed(yield* ctx.run("Think hard", { effort: "xhigh" }))
            expect(high.variant).toBe("high")
            const cheap = completed(yield* ctx.run("Think less", { effort: "low" }))
            expect(cheap.variant).toBe("low")
            const plain = completed(yield* ctx.run("Inherit", {}))
            expect(plain.variant).toBeUndefined()
            const [first, second, third] = yield* ctx.requests
            expect(first.reasoning_effort).toBe("high")
            expect(second.reasoning_effort).toBe("low")
            expect(third.reasoning_effort).toBeUndefined()

            const fallback = completed(yield* ctx.run("Elsewhere", { model: "nowhere/missing-model" }))
            expect(fallback.model).toEqual({ providerID: "test", modelID: "test-model" })
            expect(fallback.warning).toContain('opts.model "nowhere/missing-model" is unavailable')
          }),
        { config },
      ),
    60_000,
  )

  it.live(
    "rejects invalid options, unknown agent types and primary agents before any child session",
    () =>
      provideTmpdirServer(
        () =>
          Effect.gen(function* () {
            const ctx = yield* setup()
            const created: string[] = []
            const track = (id: string) => created.push(id)

            const schema = errored(yield* ctx.run("x", { schema: { type: "array" } }, track))
            expect(schema.terminal).toBe(false)
            expect(schema.error).toBe("schema must have {type: 'object', properties: {...}} at its root")

            const unknown = errored(yield* ctx.run("x", { agentType: "no-such-agent" }, track))
            expect(unknown.terminal).toBe(false)
            expect(unknown.error).toContain("no-such-agent")

            const primary = errored(yield* ctx.run("x", { agentType: "code" }, track))
            expect(primary.terminal).toBe(false)
            expect(primary.error).toContain("primary agent")

            const isolation = errored(yield* ctx.run("x", { isolation: "branch" as "worktree" }, track))
            expect(isolation.error).toBe("opts.isolation must be 'worktree'")

            expect(created).toEqual([])
            expect(yield* ctx.requests).toHaveLength(0)
            expect(WorkflowSpawn.check({ agentType: "" })).toBe("opts.agentType must be a non-empty string")
            expect(WorkflowSpawn.check({ label: 5 as unknown as string })).toBe("opts.label must be a string")
            expect(WorkflowSpawn.check({ phase: 2 as unknown as string })).toBe("opts.phase must be a string")
            expect(WorkflowSpawn.check({ schema: person, effort: "high", label: "x", phase: "P" })).toBeUndefined()

            // Fail closed when the launching agent no longer resolves: its rules are every agent's ceiling.
            const gone = errored(yield* ctx.run("x", {}, track, { caller: "renamed-away" }))
            expect(gone.error).toBe('launching agent "renamed-away" is no longer available')
            expect(created).toEqual([])
          }),
        { config },
      ),
    60_000,
  )

  it.live(
    "a subagent type the launching agent's task permission denies cannot run",
    () =>
      provideTmpdirServer(
        () =>
          Effect.gen(function* () {
            const ctx = yield* setup()
            const created: string[] = []
            const denied = errored(yield* ctx.run("x", { agentType: "explore" }, (id) => created.push(id)))
            expect(denied.terminal).toBe(false)
            expect(denied.error).toBe('Agent type "explore" is denied by the launching agent\'s task permission')
            expect(created).toEqual([])
            expect(yield* ctx.requests).toHaveLength(0)
          }),
        {
          config: (url: string) => ({
            ...config(url),
            agent: { code: { model: "test/test-model", permission: { task: { "*": "allow", explore: "deny" } } } },
          }),
        },
      ),
    60_000,
  )

  it.live(
    "an explicit opts.model keeps the session effort",
    () =>
      provideTmpdirServer(
        () =>
          Effect.gen(function* () {
            const ctx = yield* setup("high")
            const swapped = completed(yield* ctx.run("Swap the model", { model: "test/test-model" }))
            expect(swapped.variant).toBe("high")
            const lowered = completed(yield* ctx.run("Lower it", { model: "test/test-model", effort: "low" }))
            expect(lowered.variant).toBe("low")
            const [first, second] = yield* ctx.requests
            expect(first.reasoning_effort).toBe("high")
            expect(second.reasoning_effort).toBe("low")
          }),
        { config },
      ),
    60_000,
  )

  it.live(
    "a session stopped before its first reply skips the agent instead of returning its prompt",
    () =>
      provideTmpdirServer(
        () =>
          Effect.gen(function* () {
            const ctx = yield* setup()
            const sent: string[] = []
            // What prompt() hands back when the child was cancelled from outside before any assistant message.
            const stopped: TaskPromptOps = {
              ...ctx.ops,
              prompt: (input) =>
                Effect.sync(() => {
                  sent.push(input.sessionID)
                  return {
                    info: { id: input.messageID, role: "user", sessionID: input.sessionID },
                    parts: [{ type: "text", text: "the prompt itself" }],
                  } as unknown as SessionV1.WithParts
                }),
            }
            const plain = yield* ctx.run("Never answered", {}, undefined, { ops: stopped })
            expect(plain.status).toBe("skipped")
            const structured = yield* ctx.run("Never answered", { schema: person }, undefined, { ops: stopped })
            expect(structured.status).toBe("skipped")
            // No re-prompt of a session the user just stopped.
            expect(sent).toHaveLength(2)
          }),
        { config },
      ),
    60_000,
  )

  it.live(
    "a custom agentType keeps its own prompt and gets the workflow return note",
    () =>
      provideTmpdirServer(
        () =>
          Effect.gen(function* () {
            const ctx = yield* setup()
            yield* ctx.llm.tool(WorkflowPrompts.STRUCTURED_OUTPUT_TOOL, { name: "Ada" })
            const outcome = completed(yield* ctx.run("Find Ada", { agentType: "explore", schema: person }))
            expect(outcome.value).toEqual({ name: "Ada" })
            const [request] = yield* ctx.requests
            // explore denies "*", so StructuredOutput must be re-allowed for its answer to arrive.
            expect(tools(request)).toContain(WorkflowPrompts.STRUCTURED_OUTPUT_TOOL)
            expect(system(request)).toContain(WorkflowPrompts.NOTE_STRUCTURED.trim())
            expect(system(request)).not.toContain(WorkflowPrompts.SUBAGENT_STRUCTURED)
          }),
        { config },
      ),
    60_000,
  )

  it.live(
    "survives a tree cancel of the launching session and stops when cancelled directly",
    () =>
      provideTmpdirServer(
        () =>
          Effect.gen(function* () {
            const ctx = yield* setup()
            const status = yield* SessionStatus.Service
            yield* ctx.llm.hang
            const ids: string[] = []
            const fiber = yield* ctx.run("Wait forever", {}, (id) => ids.push(id)).pipe(Effect.forkScoped)
            const child = yield* pollWithTimeout(
              Effect.gen(function* () {
                const id = ids.at(0)
                if (!id) return undefined
                const info = yield* status.get(SessionID.make(id))
                return info.type === "busy" ? SessionID.make(id) : undefined
              }),
              "workflow agent never started",
            )

            // The user interrupting the main turn (no scope = tree) must not reach workflow agents.
            yield* ctx.prompt.cancel(ctx.parent.id)
            yield* Effect.sleep("200 millis")
            expect((yield* status.get(child)).type).toBe("busy")
            expect(fiber.pollUnsafe()).toBeUndefined()

            yield* ctx.prompt.cancel(child)
            const outcome = yield* awaitWithTimeout(Fiber.join(fiber), "agent did not stop", "10 seconds")
            expect(outcome.status).toBe("skipped")
            expect(outcome.sessionID).toBe(child)
          }),
        { config },
      ),
    60_000,
  )

  it.live(
    "interrupting the agent cancels its child session",
    () =>
      provideTmpdirServer(
        () =>
          Effect.gen(function* () {
            const ctx = yield* setup()
            const status = yield* SessionStatus.Service
            yield* ctx.llm.hang
            const ids: string[] = []
            const fiber = yield* ctx.run("Wait forever", {}, (id) => ids.push(id)).pipe(Effect.forkScoped)
            const child = yield* pollWithTimeout(
              Effect.gen(function* () {
                const id = ids.at(0)
                if (!id) return undefined
                const info = yield* status.get(SessionID.make(id))
                return info.type === "busy" ? SessionID.make(id) : undefined
              }),
              "workflow agent never started",
            )
            yield* awaitWithTimeout(Fiber.interrupt(fiber), "agent fiber did not interrupt", "10 seconds")
            yield* pollWithTimeout(
              status.get(child).pipe(Effect.map((info) => (info.type === "idle" ? true : undefined))),
              "child session kept running after the agent was interrupted",
            )
          }),
        { config },
      ),
    60_000,
  )

  it.live(
    "isolation: 'worktree' refuses non-git projects",
    () =>
      provideTmpdirServer(
        () =>
          Effect.gen(function* () {
            const ctx = yield* setup()
            const outcome = errored(yield* ctx.run("Edit in isolation", { isolation: "worktree" }))
            expect(outcome.terminal).toBe(false)
            expect(outcome.error).toBe("isolation: 'worktree' requires a git repository")
            expect(yield* ctx.requests).toHaveLength(0)
          }),
        { config },
      ),
    60_000,
  )

  it.live(
    "isolation: 'worktree' keeps a changed worktree on a branch and removes an unchanged one",
    () =>
      provideTmpdirServer(
        ({ dir }) =>
          Effect.gen(function* () {
            // Worktrees check out HEAD, so the provider config has to be committed to reach them.
            yield* Effect.promise(() => $`git add opencode.json && git commit -m config`.cwd(dir).quiet())
            const ctx = yield* setup()
            yield* ctx.llm.tool("bash", { command: "touch made-by-agent.txt", description: "Create a file" })
            yield* ctx.llm.text("created")
            const changed = completed(yield* ctx.run("Create a file", { isolation: "worktree" }))
            expect(changed.value).toBe("created")
            const kept = changed.worktree
            if (!kept) throw new Error("missing worktree result")
            expect(kept.changed).toBe(true)
            expect(kept.branch).toBe("kilo/wf/wf_0123abcd-abc-0")
            expect(path.resolve(kept.path)).not.toBe(path.resolve(dir))
            expect(existsSync(path.join(kept.path, "made-by-agent.txt"))).toBe(true)
            expect(existsSync(path.join(dir, "made-by-agent.txt"))).toBe(false)
            const branch = yield* Effect.promise(() => $`git rev-parse --abbrev-ref HEAD`.cwd(kept.path).quiet().text())
            expect(branch.trim()).toBe("kilo/wf/wf_0123abcd-abc-0")

            const child = yield* ctx.sessions.get(SessionID.make(changed.sessionID))
            expect(path.resolve(child.directory)).toBe(path.resolve(kept.path))
            expect(child.parentID).toBe(ctx.parent.id)
            const [first] = yield* ctx.requests
            expect(system(first)).toContain(`You are running in an isolated git worktree at \`${kept.path}\``)
            expect(system(first)).toContain(WorkflowPrompts.SUBAGENT_TEXT)

            yield* ctx.llm.text("nothing to change")
            const clean = completed(yield* ctx.run("Look around", { isolation: "worktree" }))
            const removed = clean.worktree
            if (!removed) throw new Error("missing worktree result")
            expect(removed.changed).toBe(false)
            expect(removed.branch).toBeUndefined()
            expect(existsSync(removed.path)).toBe(false)

            // Stopping an isolated agent mid-turn still inspects its worktree, and removes it when unchanged.
            // (Session status is per instance, so wait for its provider request instead.)
            const sent = (yield* ctx.requests).length
            yield* ctx.llm.hang
            const ids: string[] = []
            const fiber = yield* ctx
              .run("Wait forever", { isolation: "worktree" }, (id) => ids.push(id))
              .pipe(Effect.forkScoped)
            const stuck = yield* pollWithTimeout(
              Effect.gen(function* () {
                const id = ids.at(0)
                if (!id || (yield* ctx.requests).length <= sent) return undefined
                return SessionID.make(id)
              }),
              "isolated agent never started",
            )
            const directory = (yield* ctx.sessions.get(stuck)).directory
            expect(existsSync(directory)).toBe(true)
            yield* awaitWithTimeout(Fiber.interrupt(fiber), "isolated agent did not stop", "20 seconds")
            expect(existsSync(directory)).toBe(false)

            yield* Effect.promise(() => $`git worktree remove --force ${kept.path}`.cwd(dir).quiet().nothrow())
          }),
        { config, git: true },
      ),
    120_000,
  )
})
