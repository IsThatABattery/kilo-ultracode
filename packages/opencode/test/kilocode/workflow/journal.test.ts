import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect } from "effect"
import { WorkflowJournal } from "../../../src/kilocode/workflow/journal"
import { tmpdir } from "../../fixture/fixture"

const entry = (index: number, key: string, value: unknown): WorkflowJournal.Result => ({
  type: "result",
  index,
  key,
  label: `agent-${index}`,
  value,
})

describe("WorkflowJournal.key", () => {
  test("ignores label and phase", () => {
    const base = WorkflowJournal.key("find bugs", { model: "a/b" })
    expect(WorkflowJournal.key("find bugs", { model: "a/b", label: "x", phase: "Scan" })).toBe(base)
  })

  test("is independent of option and schema key order", () => {
    const a = WorkflowJournal.key("p", {
      effort: "low",
      schema: { type: "object", properties: { a: { type: "string" }, b: { type: "number" } } },
    })
    const b = WorkflowJournal.key("p", {
      schema: { properties: { b: { type: "number" }, a: { type: "string" } }, type: "object" },
      effort: "low",
    })
    expect(a).toBe(b)
  })

  test("changes when the prompt or a behavioral option changes", () => {
    const base = WorkflowJournal.key("p", {})
    expect(WorkflowJournal.key("p2", {})).not.toBe(base)
    expect(WorkflowJournal.key("p", { effort: "high" })).not.toBe(base)
    expect(WorkflowJournal.key("p", { isolation: "worktree" })).not.toBe(base)
    expect(base).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe("WorkflowJournal.replay", () => {
  test("serves repeated keys by occurrence in start order", () => {
    // Completion order differs from start order; replay follows the start index.
    const cache = WorkflowJournal.replay([entry(1, "k", "second"), entry(0, "k", "first"), entry(2, "j", "other")])
    expect(cache.take("k")).toEqual({ value: "first" })
    expect(cache.take("j")).toEqual({ value: "other" })
    expect(cache.take("k")).toEqual({ value: "second" })
    expect(cache.diverged).toBe(false)
  })

  test("runs everything live after the first miss", () => {
    const cache = WorkflowJournal.replay([entry(0, "a", 1), entry(1, "b", 2), entry(2, "c", 3)])
    expect(cache.take("a")).toEqual({ value: 1 })
    expect(cache.take("edited")).toBeUndefined()
    expect(cache.diverged).toBe(true)
    // "c" is cached, but it started after the divergence point.
    expect(cache.take("c")).toBeUndefined()
  })

  test("an extra occurrence of a cached key is a miss", () => {
    const cache = WorkflowJournal.replay([entry(0, "a", "x")])
    expect(cache.take("a")).toEqual({ value: "x" })
    expect(cache.take("a")).toBeUndefined()
    expect(cache.diverged).toBe(true)
  })

  test("a pending slot (whole-run stop) reruns live without ending the cached prefix", () => {
    const pending: WorkflowJournal.Pending = { type: "pending", index: 1, key: "b" }
    const cache = WorkflowJournal.replay([entry(0, "a", 1), pending, entry(2, "c", 3), entry(3, "d", 4)])
    expect(cache.take("a")).toEqual({ value: 1 })
    expect(cache.take("b")).toBeUndefined()
    expect(cache.diverged).toBe(false)
    expect(cache.take("c")).toEqual({ value: 3 })
    expect(cache.take("d")).toEqual({ value: 4 })
  })

  test("cached null and empty values are still hits", () => {
    const cache = WorkflowJournal.replay([entry(0, "a", null), entry(1, "b", "")])
    expect(cache.take("a")).toEqual({ value: null })
    expect(cache.take("b")).toEqual({ value: "" })
  })
})

describe("WorkflowJournal.rest", () => {
  const previous = [entry(3, "c", "c0"), entry(0, "a", "a0"), entry(1, "b", "b0"), entry(2, "a", "a1")]

  test("keeps the occurrences of each key beyond the ones re-recorded", () => {
    const kept = WorkflowJournal.rest(previous, new Map([["a", 1]]), 1)
    expect(kept.map((item) => item.value)).toEqual(["b0", "a1", "c0"])
    expect(kept.map((item) => item.index)).toEqual([1, 2, 3])
    expect(
      WorkflowJournal.rest(
        previous,
        new Map([
          ["a", 2],
          ["b", 1],
          ["c", 1],
        ]),
        4,
      ),
    ).toEqual([])
  })

  test("shifts kept entries after this run's indexes, so they replay after its results for the same key", () => {
    const kept = WorkflowJournal.rest(previous, new Map([["a", 1]]), 5)
    expect(kept.map((item) => item.index)).toEqual([5, 6, 7])
    const replay = WorkflowJournal.replay([entry(4, "a", "fresh"), ...kept])
    expect(replay.take("a")).toEqual({ value: "fresh" })
    expect(replay.take("a")).toEqual({ value: "a1" })
  })
})

describe("WorkflowJournal.recover", () => {
  test("a staged journal comes first, then the base entries it never reached", () => {
    const base = [entry(0, "a", "a0"), entry(1, "b", "b0"), entry(2, "c", "c0")]
    const staged = [entry(0, "a", "a0"), entry(1, "x", "x0")]
    const merged = WorkflowJournal.recover(base, staged)
    expect(merged?.map((item) => [item.key, item.index])).toEqual([
      ["a", 0],
      ["x", 1],
      ["b", 2],
      ["c", 3],
    ])
    expect(WorkflowJournal.recover(base, undefined)).toBe(base)
    expect(WorkflowJournal.recover(undefined, staged)).toEqual(staged)
    expect(WorkflowJournal.recover(undefined, undefined)).toBeUndefined()
  })
})

describe("WorkflowJournal files", () => {
  test("load returns undefined for a missing journal", async () => {
    await using dir = await tmpdir()
    expect(await Effect.runPromise(WorkflowJournal.load(path.join(dir.path, "journal.jsonl")))).toBeUndefined()
  })

  test("writer appends one line per entry, concurrently, and load reads them back", async () => {
    await using dir = await tmpdir()
    const file = path.join(dir.path, "journal.jsonl")
    const writer = WorkflowJournal.writer(file)
    await Effect.runPromise(writer.reset())
    const big = "x".repeat(200_000)
    await Effect.runPromise(
      Effect.all(
        Array.from({ length: 20 }, (_, index) => writer.append(entry(index, `k${index}`, { big, index }))),
        { concurrency: "unbounded" },
      ),
    )
    const lines = (await Bun.file(file).text()).trim().split("\n")
    expect(lines).toHaveLength(20)
    for (const line of lines) expect(JSON.parse(line).type).toBe("result")
    const loaded = await Effect.runPromise(WorkflowJournal.load(file))
    expect(loaded?.map((item) => item.index).toSorted((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, i) => i))
  })

  test("load skips a torn trailing line and foreign lines", async () => {
    await using dir = await tmpdir()
    const file = path.join(dir.path, "journal.jsonl")
    await fs.writeFile(
      file,
      [
        JSON.stringify(entry(0, "a", { ok: true })),
        JSON.stringify({ type: "note", text: "not a result" }),
        JSON.stringify({ ...entry(1, "b", "v"), phase: "Scan" }),
        '{"type":"result","index":2,"key":"c","val',
      ].join("\n"),
    )
    const loaded = await Effect.runPromise(WorkflowJournal.load(file))
    expect(loaded).toEqual([entry(0, "a", { ok: true }), { ...entry(1, "b", "v"), phase: "Scan" }])
  })

  test("restore appends back the previous entries a resumed run never reached, once", async () => {
    await using dir = await tmpdir()
    const file = path.join(dir.path, "journal.jsonl")
    const previous = [entry(0, "a", "a0"), entry(1, "b", "b0"), entry(2, "c", "c0")]
    const writer = WorkflowJournal.writer(file)
    await Effect.runPromise(writer.reset())
    await Effect.runPromise(writer.append(entry(0, "a", "a0")))
    await Effect.runPromise(writer.append(entry(1, "x", "x0")))
    await Effect.runPromise(writer.restore(previous))
    await Effect.runPromise(writer.restore(previous))
    const loaded = await Effect.runPromise(WorkflowJournal.load(file))
    expect(loaded?.map((item) => [item.key, item.index, item.type === "result" ? item.value : "pending"])).toEqual([
      ["a", 0, "a0"],
      ["x", 1, "x0"],
      ["b", 2, "b0"],
      ["c", 3, "c0"],
    ])
  })

  test("load reads pending lines", async () => {
    await using dir = await tmpdir()
    const file = path.join(dir.path, "journal.jsonl")
    await fs.writeFile(file, JSON.stringify({ type: "pending", index: 3, key: "k", extra: 1 }) + "\n")
    expect(await Effect.runPromise(WorkflowJournal.load(file))).toEqual([{ type: "pending", index: 3, key: "k" }])
  })

  test("a staged writer leaves the journal alone until commit replaces it", async () => {
    await using dir = await tmpdir()
    const file = path.join(dir.path, "journal.jsonl")
    await fs.writeFile(file, JSON.stringify(entry(0, "old", 1)) + "\n")
    const writer = WorkflowJournal.writer(file, { staged: true })
    await Effect.runPromise(writer.reset())
    await Effect.runPromise(writer.append(entry(0, "new", 2)))
    // A hard kill now would leave both: the previous journal intact and this run's partial one beside it.
    expect((await Effect.runPromise(WorkflowJournal.load(file)))?.map((item) => item.key)).toEqual(["old"])
    const staged = path.join(dir.path, WorkflowJournal.STAGED)
    expect((await Effect.runPromise(WorkflowJournal.load(staged)))?.map((item) => item.key)).toEqual(["new"])
    await Effect.runPromise(writer.commit())
    await Effect.runPromise(writer.commit())
    expect(await Bun.file(staged).exists()).toBe(false)
    await Effect.runPromise(writer.append(entry(1, "late", 3)))
    expect((await Effect.runPromise(WorkflowJournal.load(file)))?.map((item) => item.key)).toEqual(["new", "late"])
  })

  test("reset truncates an existing journal", async () => {
    await using dir = await tmpdir()
    const file = path.join(dir.path, "journal.jsonl")
    await fs.writeFile(file, JSON.stringify(entry(0, "a", 1)) + "\n")
    await Effect.runPromise(WorkflowJournal.writer(file).reset())
    expect(await Bun.file(file).text()).toBe("")
  })
})
