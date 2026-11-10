import { afterEach, describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Database } from "@opencode-ai/core/database/database"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { MemoryService } from "@kilocode/kilo-memory/effect/service"
import type { Agent } from "../../../src/agent/agent"
import { Config } from "../../../src/config/config"
import { RuntimeFlags } from "../../../src/effect/runtime-flags"
import { KiloSessions } from "../../../src/kilo-sessions/kilo-sessions"
import { Permission } from "../../../src/permission"
import { MessageV2 } from "../../../src/session/message-v2"
import { SessionPrompt } from "../../../src/session/prompt"
import { SessionReminders } from "../../../src/session/reminders"
import { MessageID, PartID, SessionID } from "../../../src/session/schema"
import { Session } from "../../../src/session/session"
import { SessionSummary } from "../../../src/session/summary"
import { KiloUltracode } from "../../../src/kilocode/workflow/ultracode"
import { WorkflowPrompts } from "../../../src/kilocode/workflow/prompts"
import { disposeAllInstances, provideTmpdirInstance, provideTmpdirServer } from "../../fixture/fixture"
import { testEffect } from "../../lib/effect"
import { TestLLMServer } from "../../lib/llm-server"

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      Session.node,
      SessionProjector.node,
      Config.node,
      RuntimeFlags.node,
      Database.node,
      CrossSpawnSpawner.node,
    ]),
  ),
)

afterEach(disposeAllInstances)

const model = { providerID: ProviderV2.ID.make("openai"), modelID: ModelV2.ID.make("gpt-4") }
const code = { name: "code", native: true, permission: Permission.fromConfig({ "*": "allow" }) } as Agent.Info
const locked = { name: "locked", permission: Permission.fromConfig({ "*": "allow", workflow: "deny" }) } as Agent.Info

const ON = WorkflowPrompts.wrap(WorkflowPrompts.ULTRACODE_ON)
const OFF = WorkflowPrompts.wrap(WorkflowPrompts.ULTRACODE_OFF)
const KEYWORD = WorkflowPrompts.wrap(WorkflowPrompts.ULTRACODE_KEYWORD)

const text = (value: string, extra: Partial<MessageV2.TextPart> = {}) => ({ type: "text", text: value, ...extra })

describe("KiloUltracode.keyword", () => {
  test("matches the human-typed keyword as a whole word, any case", () => {
    expect(KiloUltracode.keyword([text("please ultracode this refactor")])).toBe(true)
    expect(KiloUltracode.keyword([text("ULTRACODE: audit the auth module")])).toBe(true)
    expect(KiloUltracode.keyword([text("first line\nUltracode.")])).toBe(true)
    expect(KiloUltracode.keyword([text("fix it"), text("ultracode")])).toBe(true)
  })

  test("ignores partial words and prompts without the keyword", () => {
    expect(KiloUltracode.keyword([text("ultracoded is not a word")])).toBe(false)
    expect(KiloUltracode.keyword([text("superultracode")])).toBe(false)
    expect(KiloUltracode.keyword([text("fix the bug")])).toBe(false)
    expect(KiloUltracode.keyword([])).toBe(false)
  })

  test("ignores synthetic, ignored, and Kilo-injected text", () => {
    expect(KiloUltracode.keyword([text("ultracode", { synthetic: true })])).toBe(false)
    expect(KiloUltracode.keyword([text("ultracode", { ignored: true })])).toBe(false)
    expect(
      KiloUltracode.keyword([text("Run ultracode review", { metadata: { kilo: { injected: { title: "/x" } } } })]),
    ).toBe(false)
    // Non-Kilo metadata does not hide human text.
    expect(KiloUltracode.keyword([text("ultracode", { metadata: { kind: "other" } })])).toBe(true)
  })

  test("ignores slash commands such as `/ultracode off` and non-text parts", () => {
    expect(KiloUltracode.keyword([text("/ultracode off")])).toBe(false)
    expect(KiloUltracode.keyword([text("  /review ultracode")])).toBe(false)
    expect(KiloUltracode.keyword([{ type: "file", text: "ultracode" }])).toBe(false)
  })
})

describe("KiloUltracode.enabled", () => {
  const flags = { disableWorkflows: false }
  const on = { metadata: { [KiloUltracode.KEY]: { enabled: true } } }
  const off = { metadata: { [KiloUltracode.KEY]: { enabled: false } } }

  test("session toggle wins over the config default", () => {
    expect(KiloUltracode.enabled(on, {}, flags)).toBe(true)
    expect(KiloUltracode.enabled(off, { experimental: { ultracode: true } }, flags)).toBe(false)
    expect(KiloUltracode.enabled({}, { experimental: { ultracode: true } }, flags)).toBe(true)
    expect(KiloUltracode.enabled({}, {}, flags)).toBe(false)
  })

  test("is always off when workflows are disabled", () => {
    expect(KiloUltracode.enabled(on, { experimental: { workflows: false } }, flags)).toBe(false)
    expect(KiloUltracode.enabled(on, {}, { disableWorkflows: true })).toBe(false)
  })

  test("read tolerates malformed metadata", () => {
    expect(KiloUltracode.read(undefined)).toEqual({})
    expect(KiloUltracode.read({ [KiloUltracode.KEY]: "yes" })).toEqual({})
    expect(KiloUltracode.read({ [KiloUltracode.KEY]: { enabled: "yes" } })).toEqual({})
    expect(KiloUltracode.read({ [KiloUltracode.KEY]: { enabled: false } })).toEqual({ enabled: false })
  })
})

const seed = Effect.fn("UltracodeTest.seed")(function* (sessionID: SessionID, parts: Partial<MessageV2.TextPart>[]) {
  const sessions = yield* Session.Service
  const info: MessageV2.User = {
    id: MessageID.ascending(),
    sessionID,
    role: "user",
    agent: "code",
    time: { created: Date.now() },
    model,
  }
  yield* sessions.updateMessage(info)
  for (const part of parts) {
    yield* sessions.updatePart({
      id: PartID.ascending(),
      messageID: info.id,
      sessionID,
      type: "text",
      text: "",
      ...part,
    } as MessageV2.TextPart)
  }
  return info
})

/** One reminder pass over the persisted history, as the prompt loop does each step. */
const step = Effect.fn("UltracodeTest.step")(function* (sessionID: SessionID, agent: Agent.Info = code) {
  const sessions = yield* Session.Service
  const session = yield* sessions.get(sessionID)
  const messages = yield* sessions.messages({ sessionID })
  yield* SessionReminders.apply({ messages, agent, session })
  return messages
})

/** Reminder kinds persisted on a message, in order. */
const reminders = Effect.fn("UltracodeTest.reminders")(function* (sessionID: SessionID, messageID: MessageID) {
  const sessions = yield* Session.Service
  const messages = yield* sessions.messages({ sessionID })
  const message = messages.find((item) => item.info.id === messageID)
  return (message?.parts ?? []).flatMap((part) => {
    if (part.type !== "text") return []
    const kind = (part.metadata?.kilo as { reminder?: string } | undefined)?.reminder
    return kind ? [{ kind, text: part.text, synthetic: part.synthetic }] : []
  })
})

describe("KiloUltracode.set", () => {
  it.live("merges into existing metadata and is a no-op when unchanged", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const goal = { text: "ship the release", status: "paused" }
        const chat = yield* sessions.create({ title: "merge", metadata: { "kilo.goal": goal, custom: { keep: 1 } } })

        yield* KiloUltracode.set(chat.id, true)
        const first = yield* sessions.get(chat.id)
        expect(first.metadata?.[KiloUltracode.KEY]).toEqual({ enabled: true })
        expect(first.metadata?.custom).toEqual({ keep: 1 })
        expect(first.metadata?.["kilo.goal"]).toMatchObject(goal)

        yield* Effect.sleep("5 millis")
        yield* KiloUltracode.set(chat.id, true)
        expect((yield* sessions.get(chat.id)).time.updated).toBe(first.time.updated)

        yield* KiloUltracode.set(chat.id, false)
        const second = yield* sessions.get(chat.id)
        expect(second.metadata?.[KiloUltracode.KEY]).toEqual({ enabled: false })
        expect(second.metadata?.custom).toEqual({ keep: 1 })
        expect(second.metadata?.["kilo.goal"]).toMatchObject(goal)
      }),
    ),
  )
})

describe("KiloUltracode.apply", () => {
  it.live("adds one persisted reminder per turn while on, then a single off reminder", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "toggle" })
        yield* KiloUltracode.set(chat.id, true)

        const first = yield* seed(chat.id, [{ text: "Refactor the parser" }])
        const loaded = yield* step(chat.id)
        // The in-memory history the loop sends this step carries the reminder too.
        const last = loaded.at(-1)?.parts.at(-1)
        expect(last?.type === "text" && last.text).toBe(`\n\n${ON}`)
        yield* step(chat.id)
        yield* step(chat.id)
        expect(yield* reminders(chat.id, first.id)).toEqual([{ kind: "ultracode", text: `\n\n${ON}`, synthetic: true }])

        const second = yield* seed(chat.id, [{ text: "Now the lexer" }])
        yield* step(chat.id)
        expect((yield* reminders(chat.id, second.id)).map((item) => item.kind)).toEqual(["ultracode"])

        yield* KiloUltracode.set(chat.id, false)
        const third = yield* seed(chat.id, [{ text: "Small follow-up" }])
        yield* step(chat.id)
        yield* step(chat.id)
        expect(yield* reminders(chat.id, third.id)).toEqual([
          { kind: "ultracode-off", text: `\n\n${OFF}`, synthetic: true },
        ])

        const fourth = yield* seed(chat.id, [{ text: "Another one" }])
        yield* step(chat.id)
        expect(yield* reminders(chat.id, fourth.id)).toEqual([])
      }),
    ),
  )

  it.live("a human-typed keyword opts in for that turn only", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "keyword" })

        const typed = yield* seed(chat.id, [{ text: "ultracode: harden the upload path" }])
        yield* step(chat.id)
        yield* step(chat.id)
        expect(yield* reminders(chat.id, typed.id)).toEqual([
          { kind: "ultracode-keyword", text: `\n\n${KEYWORD}`, synthetic: true },
        ])

        const plain = yield* seed(chat.id, [{ text: "thanks" }])
        yield* step(chat.id)
        expect(yield* reminders(chat.id, plain.id)).toEqual([])

        const injected = yield* seed(chat.id, [
          { text: "ultracode", synthetic: true },
          { text: "Use ultracode", metadata: { kilo: { injected: { title: "/cmd" } } } },
          { text: "/ultracode off" },
        ])
        yield* step(chat.id)
        expect(yield* reminders(chat.id, injected.id)).toEqual([])
      }),
    ),
  )

  it.live("uses the experimental.ultracode default unless the session turned it off", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const chat = yield* sessions.create({ title: "default on" })
          const first = yield* seed(chat.id, [{ text: "Plan the migration" }])
          yield* step(chat.id)
          expect((yield* reminders(chat.id, first.id)).map((item) => item.kind)).toEqual(["ultracode"])

          yield* KiloUltracode.set(chat.id, false)
          const second = yield* seed(chat.id, [{ text: "ultracode this one" }])
          yield* step(chat.id)
          expect((yield* reminders(chat.id, second.id)).map((item) => item.kind)).toEqual([
            "ultracode-off",
            "ultracode-keyword",
          ])
        }),
      { config: { experimental: { ultracode: true } } },
    ),
  )

  it.live("skips child sessions, workflow agent sessions, and agents without the workflow tool", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const root = yield* sessions.create({ title: "root" })
        const child = yield* sessions.create({ parentID: root.id, title: "child" })
        const agent = yield* sessions.create({
          title: "workflow agent",
          metadata: { [KiloUltracode.WORKFLOW]: { runID: "wf_1", agentID: "a1", index: 0 } },
        })
        for (const item of [root, child, agent]) yield* KiloUltracode.set(item.id, true)

        const nested = yield* seed(child.id, [{ text: "ultracode the child" }])
        yield* step(child.id)
        expect(yield* reminders(child.id, nested.id)).toEqual([])

        const worker = yield* seed(agent.id, [{ text: "Return the findings" }])
        yield* step(agent.id)
        expect(yield* reminders(agent.id, worker.id)).toEqual([])

        const denied = yield* seed(root.id, [{ text: "Explain the design" }])
        yield* step(root.id, locked)
        expect(yield* reminders(root.id, denied.id)).toEqual([])
      }),
    ),
  )

  it.live("adds nothing when dynamic workflows are disabled", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const chat = yield* sessions.create({ title: "disabled" })
          yield* KiloUltracode.set(chat.id, true)
          const message = yield* seed(chat.id, [{ text: "ultracode everything" }])
          yield* step(chat.id)
          expect(yield* reminders(chat.id, message.id)).toEqual([])
        }),
      { config: { experimental: { workflows: false, ultracode: true } } },
    ),
  )
})

const full = testEffect(
  LayerNode.compile(
    LayerNode.group([
      SessionPrompt.node,
      Session.node,
      CrossSpawnSpawner.node,
      Database.node,
      SessionProjector.node,
      LayerNode.make({ service: MemoryService.Service, layer: MemoryService.layer, deps: [] }),
      LayerNode.make({ service: TestLLMServer, layer: TestLLMServer.layer, deps: [] }),
    ]),
    [
      [KiloSessions.node, KiloSessions.testLayer],
      [SessionSummary.node, Layer.mock(SessionSummary.Service)({ summarize: () => Effect.void })],
    ],
  ),
)

const server = (url: string) => ({
  enabled_providers: ["test"],
  provider: {
    test: {
      npm: "@ai-sdk/openai-compatible",
      options: { baseURL: url, apiKey: "test-key" },
      models: { "test-model": { name: "Test", limit: { context: 100000, output: 10000 } } },
    },
  },
  agent: { code: { model: "test/test-model" } },
})

describe("SessionPrompt ultracode field", () => {
  full.live(
    "prompt and command persist the toggle and the model sees the matching reminder",
    () =>
      provideTmpdirServer(
        ({ llm }) =>
          Effect.gen(function* () {
            const prompt = yield* SessionPrompt.Service
            const sessions = yield* Session.Service
            const chat = yield* sessions.create({ title: "ultracode field" })
            const last = () => llm.inputs.pipe(Effect.map((items) => JSON.stringify(items.at(-1))))

            yield* llm.text("on")
            yield* prompt.prompt({
              sessionID: chat.id,
              agent: "code",
              ultracode: true,
              parts: [{ type: "text", text: "Audit the cache layer" }],
            })
            expect(KiloUltracode.read((yield* sessions.get(chat.id)).metadata)).toEqual({ enabled: true })
            expect(yield* last()).toContain("Ultracode is on")

            // Omitting the field keeps the stored toggle.
            yield* llm.text("still on")
            yield* prompt.prompt({ sessionID: chat.id, agent: "code", parts: [{ type: "text", text: "Continue" }] })
            expect(yield* last()).toContain("Ultracode is on")

            yield* llm.text("off")
            yield* prompt.command({
              sessionID: chat.id,
              agent: "code",
              command: "init",
              arguments: "",
              ultracode: false,
            })
            expect(KiloUltracode.read((yield* sessions.get(chat.id)).metadata)).toEqual({ enabled: false })
            const input = yield* last()
            expect(input).toContain("Ultracode is off")
            // The workflow tool description also says "Ultracode is on for the session"; count the reminder itself.
            expect(input.split(WorkflowPrompts.ULTRACODE_ON.slice(0, 40)).length - 1).toBe(2)
          }),
        { config: server },
      ),
    60_000,
  )
})
