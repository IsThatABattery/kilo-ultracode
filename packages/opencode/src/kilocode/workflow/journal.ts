// Resume journal for dynamic workflows: one `{"type":"result",...}` JSONL line per completed agent() call, plus a
// `{"type":"pending",...}` line per agent that was still in flight when the whole run stopped.
//
// A resumed run replays the longest unchanged prefix of agent() calls: each call (in start order) looks up
// sha256(prompt + canonical opts without label/phase) plus its occurrence index; after the first miss every later
// call runs live. A pending slot is not a miss: stopping the whole run counts no agent as failed, so that agent
// starts over while the later cached ones still replay. The resumed run writes its journal to a staged file and,
// when it ends, appends back the previous entries it never reached and moves it over the journal, so nothing cached
// is lost to an early stop or a hard kill.

import { createHash } from "crypto"
import fs from "fs/promises"
import path from "path"
import { Effect, Result, Semaphore } from "effect"
import * as Log from "@opencode-ai/core/util/log"
import type { AgentOpts } from "./types"

const log = Log.create({ service: "workflow.journal" })

export namespace WorkflowJournal {
  export const FILE = "journal.jsonl"
  /** Where a resumed run writes until it ends (then it replaces FILE). */
  export const STAGED = `${FILE}.next`

  export type Result = {
    type: "result"
    /** Start-order index of the agent within the run (nested workflows share the counter). */
    index: number
    key: string
    label: string
    phase?: string
    /** The agent's full return value, exactly as the script received it. */
    value: unknown
  }

  /** An agent still running (or queued) when the whole run stopped: it reruns on resume without ending the prefix. */
  export type Pending = { type: "pending"; index: number; key: string }

  export type Entry = Result | Pending

  /** Sort object keys recursively so equivalent opts serialize (and hash) identically. */
  export function canonical(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonical)
    if (value === null || typeof value !== "object") return value
    const record = value as Record<string, unknown>
    return Object.fromEntries(
      Object.keys(record)
        .toSorted()
        .filter((name) => record[name] !== undefined)
        .map((name) => [name, canonical(record[name])]),
    )
  }

  export function hash(value: unknown) {
    return createHash("sha256")
      .update(JSON.stringify(canonical(value)))
      .digest("hex")
  }

  /** Cache key of one agent() call: display-only options (label, phase) never invalidate a result. */
  export function key(prompt: string, opts: AgentOpts) {
    const rest = Object.fromEntries(
      Object.entries(opts).filter((entry) => entry[0] !== "label" && entry[0] !== "phase"),
    )
    return hash({ prompt, opts: rest })
  }

  function entry(line: string): Entry | undefined {
    const parsed = Result.try({ try: () => JSON.parse(line) as unknown, catch: (err) => err })
    if (Result.isFailure(parsed)) {
      // A crash mid-append leaves a torn last line; everything before it is still valid.
      log.warn("skipping unreadable journal line", { error: String(parsed.failure) })
      return undefined
    }
    const value = parsed.success
    if (!value || typeof value !== "object") return undefined
    const item = value as Partial<Result> | Partial<Pending>
    if (typeof item.key !== "string" || typeof item.index !== "number") return undefined
    if (item.type === "pending") return { type: "pending", index: item.index, key: item.key }
    if (item.type !== "result") return undefined
    return {
      type: "result",
      index: item.index,
      key: item.key,
      label: typeof item.label === "string" ? item.label : "",
      ...(typeof item.phase === "string" ? { phase: item.phase } : {}),
      value: item.value,
    }
  }

  /** Entries of a journal file, or undefined when it does not exist. */
  export const load = Effect.fn("WorkflowJournal.load")(function* (file: string) {
    const source = Bun.file(file)
    if (!(yield* Effect.promise(() => source.exists()))) return undefined
    const text = yield* Effect.promise(() => source.text())
    return text
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .flatMap((line) => entry(line) ?? [])
  })

  export type Replay = {
    /** The cached value for the next call with this key, or undefined once the call (or an earlier one) missed. */
    take(key: string): { value: unknown } | undefined
    /** True after the first miss: from then on every call runs live. */
    readonly diverged: boolean
  }

  /** Replay cache over a previous run's entries, consumed per key in start order. */
  export function replay(entries: ReadonlyArray<Entry>): Replay {
    // undefined marks a pending slot.
    const cache = new Map<string, Array<{ value: unknown } | undefined>>()
    for (const item of entries.toSorted((a, b) => a.index - b.index)) {
      cache.set(item.key, [...(cache.get(item.key) ?? []), item.type === "result" ? { value: item.value } : undefined])
    }
    const seen = new Map<string, number>()
    const state = { diverged: false }
    return {
      take(key) {
        const occurrence = seen.get(key) ?? 0
        seen.set(key, occurrence + 1)
        if (state.diverged) return undefined
        const slots = cache.get(key) ?? []
        if (occurrence >= slots.length) {
          state.diverged = true
          return undefined
        }
        return slots[occurrence]
      },
      get diverged() {
        return state.diverged
      },
    }
  }

  /**
   * Entries of a previous journal that a resumed run did not record again: per key, the occurrences beyond the
   * `counts` it appended. When needed their indexes shift to start at `next`, so on the following resume they
   * replay after this run's results for the same key.
   */
  export function rest<T extends Entry>(previous: ReadonlyArray<T>, counts: ReadonlyMap<string, number>, next: number) {
    const seen = new Map<string, number>()
    const items = previous
      .toSorted((a, b) => a.index - b.index)
      .filter((item) => {
        const occurrence = seen.get(item.key) ?? 0
        seen.set(item.key, occurrence + 1)
        return occurrence >= (counts.get(item.key) ?? 0)
      })
    const shift = Math.max(0, next - (items.at(0)?.index ?? next))
    return items.map((item) => ({ ...item, index: item.index + shift }))
  }

  /** Appends per key in `entries`. */
  function tally(entries: ReadonlyArray<Entry>) {
    const counts = new Map<string, number>()
    for (const item of entries) counts.set(item.key, (counts.get(item.key) ?? 0) + 1)
    return counts
  }

  /**
   * The cache a resume starts from. `staged` is what a previous resumed run wrote before it was hard-killed (it
   * never moved it over the journal): its entries come first, then the base journal's entries it never reached.
   */
  export function recover(base: ReadonlyArray<Entry> | undefined, staged: ReadonlyArray<Entry> | undefined) {
    if (!staged) return base
    const next = Math.max(-1, ...staged.map((item) => item.index)) + 1
    return [...staged, ...rest(base ?? [], tally(staged), next)]
  }

  /**
   * Append-only writer; appends are serialized so concurrent agents never interleave partial lines. A `staged`
   * writer writes to STAGED next to `file` until `commit` moves it over `file`.
   */
  export function writer(file: string, opts: { staged?: boolean } = {}) {
    const lock = Semaphore.makeUnsafe(1)
    // Appends per key and the highest index appended, counted when an append is issued (see restore).
    const counts = new Map<string, number>()
    const state = { last: -1, target: opts.staged ? path.join(path.dirname(file), STAGED) : file }
    const count = (item: Entry) => {
      counts.set(item.key, (counts.get(item.key) ?? 0) + 1)
      state.last = Math.max(state.last, item.index)
    }
    const line = (item: Entry) => JSON.stringify(item) + "\n"
    // A lost journal line only costs a cache miss on resume, so write failures are logged, never raised.
    const guard = (work: () => Promise<unknown>) =>
      lock.withPermits(1)(
        Effect.tryPromise(work).pipe(
          Effect.catch((err) => Effect.sync(() => log.error("workflow journal write failed", { file, err }))),
          Effect.asVoid,
        ),
      )
    return {
      append: (item: Entry) => {
        count(item)
        return guard(() => fs.appendFile(state.target, line(item)))
      },
      /** Start an empty journal (a resumed run rewrites it with the results it serves and produces). */
      reset: () => guard(() => Bun.write(state.target, "")),
      /**
       * Append back the previous journal's entries this run never re-recorded (it stopped early, or diverged
       * before reaching them), so a later resume still serves them. Safe to call more than once.
       */
      restore: (previous: ReadonlyArray<Entry>) =>
        Effect.suspend(() => {
          const items = rest(previous, counts, state.last + 1)
          if (items.length === 0) return Effect.void
          items.forEach(count)
          return guard(() => fs.appendFile(state.target, items.map(line).join("")))
        }),
      /** Move a staged journal over `file`; later appends go to `file`. A no-op once done or when not staged. */
      commit: () =>
        guard(async () => {
          if (state.target === file) return
          await fs.rename(state.target, file)
          state.target = file
        }),
    }
  }
}
