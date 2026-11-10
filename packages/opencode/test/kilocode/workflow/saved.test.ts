import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Global } from "@opencode-ai/core/global"
import { Command } from "../../../src/command"
import { Skill } from "../../../src/skill"
import { WorkflowSaved } from "../../../src/kilocode/workflow/saved"
import { provideTmpdirInstance, tmpdir } from "../../fixture/fixture"
import { testEffect } from "../../lib/effect"

const script = (name: string, description = `${name} workflow`) =>
  `export const meta = { name: ${JSON.stringify(name)}, description: ${JSON.stringify(description)}, phases: [{ title: "Scan" }] }\nphase("Scan")\nreturn await agent("scan")\n`

async function put(file: string, text: string) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await Bun.write(file, text)
}

const globals: string[] = []
afterEach(async () => {
  await Promise.all(globals.splice(0).map((file) => fs.rm(file, { force: true })))
})

describe("WorkflowSaved.list", () => {
  test("discovers workflows/*.js by meta name and skips files that do not parse", async () => {
    await using tmp = await tmpdir()
    const dir = path.join(tmp.path, ".kilo")
    await put(path.join(dir, "workflows", "hunt.js"), script("bug-hunt", "Find bugs"))
    await put(path.join(dir, "workflows", "broken.js"), "const meta = 1")
    await put(path.join(dir, "workflows", "legacy.md"), "# Legacy\n\nMarkdown workflow")
    await put(path.join(dir, "workflows", "nested", "deep.js"), script("deep"))
    await put(path.join(dir, "workflows", "zeta.js"), script("zeta"))

    const items = await WorkflowSaved.list({ directories: [dir], directory: tmp.path })
    expect(items.map((item) => item.name)).toEqual(["bug-hunt", "zeta"])
    expect(items[0]).toMatchObject({
      name: "bug-hunt",
      description: "Find bugs",
      phases: [{ title: "Scan" }],
      path: path.join(dir, "workflows", "hunt.js"),
      scope: "project",
    })
  })

  test("nearest project directory wins, .kilo beats .kilocode, and project beats global", async () => {
    await using tmp = await tmpdir()
    const root = tmp.path
    const sub = path.join(root, "packages", "app")
    const near = path.join(sub, ".kilo")
    const far = path.join(root, ".kilo")
    const legacy = path.join(sub, ".kilocode")
    const global = Global.Path.config
    await put(path.join(far, "workflows", "shared.js"), script("shared", "from root"))
    await put(path.join(far, "workflows", "rooted.js"), script("rooted", "only at root"))
    await put(path.join(near, "workflows", "shared.js"), script("shared", "from package"))
    await put(path.join(legacy, "workflows", "shared.js"), script("shared", "from legacy dir"))
    await put(path.join(legacy, "workflows", "old.js"), script("old", "legacy only"))
    const file = path.join(global, "workflows", "saved-test-global.js")
    const own = path.join(global, "workflows", "saved-test-own.js")
    globals.push(file, own)
    await put(file, script("shared", "from global"))
    await put(own, script("saved-test-own", "global only"))

    // Config.directories() order: global config first, then project dirs nearest first.
    const directories = [global, legacy, near, far]
    const items = await WorkflowSaved.list({ directories, directory: sub })
    const by = Object.fromEntries(items.map((item) => [item.name, item]))
    expect(by.shared).toMatchObject({ description: "from package", scope: "project" })
    expect(by.rooted).toMatchObject({ description: "only at root", scope: "project" })
    expect(by.old).toMatchObject({ description: "legacy only", scope: "project" })
    expect(by["saved-test-own"]).toMatchObject({ description: "global only", scope: "global" })
    expect(items.filter((item) => item.name === "shared")).toHaveLength(1)

    expect(WorkflowSaved.order({ directories, directory: sub }).map((item) => item.dir)).toEqual([
      near,
      legacy,
      far,
      global,
    ])
  })

  test("find resolves by meta name, then by file name", async () => {
    await using tmp = await tmpdir()
    const dir = path.join(tmp.path, ".kilo")
    await put(path.join(dir, "workflows", "review-file.js"), script("Deep Review"))
    const input = { directories: [dir], directory: tmp.path }
    expect((await WorkflowSaved.find({ ...input, name: "Deep Review" }))?.name).toBe("Deep Review")
    expect((await WorkflowSaved.find({ ...input, name: "review-file" }))?.name).toBe("Deep Review")
    expect(await WorkflowSaved.find({ ...input, name: "missing" })).toBeUndefined()
  })
})

describe("WorkflowSaved.save", () => {
  test("project scope writes to the closest existing .kilo/workflows, else the worktree root", async () => {
    await using tmp = await tmpdir()
    const root = tmp.path
    const sub = path.join(root, "packages", "app", "src")
    await fs.mkdir(sub, { recursive: true })
    const base = { scope: "project" as const, worktree: root, global: Global.Path.config }

    const first = await WorkflowSaved.save({ ...base, script: script("bug-hunt"), name: "bug-hunt", directory: sub })
    expect(first).toBe(path.join(root, ".kilo", "workflows", "bug-hunt.js"))
    expect(await Bun.file(first).text()).toBe(script("bug-hunt"))

    await fs.mkdir(path.join(root, "packages", "app", ".kilo", "workflows"), { recursive: true })
    const second = await WorkflowSaved.save({
      ...base,
      script: script("Deep Review"),
      name: "Deep Review",
      directory: sub,
    })
    expect(second).toBe(path.join(root, "packages", "app", ".kilo", "workflows", "Deep-Review.js"))

    // Saving again replaces the file.
    await WorkflowSaved.save({ ...base, script: "export const meta = {}", name: "Deep Review", directory: sub })
    expect(await Bun.file(second).text()).toBe("export const meta = {}")
  })

  test("global scope writes to <global>/workflows", async () => {
    await using tmp = await tmpdir()
    const global = path.join(tmp.path, "config")
    const file = await WorkflowSaved.save({
      script: script("g"),
      name: "g",
      scope: "global",
      directory: tmp.path,
      worktree: tmp.path,
      global,
    })
    expect(file).toBe(path.join(global, "workflows", "g.js"))
  })

  test("refuses to write through symlinks", async () => {
    await using tmp = await tmpdir()
    await using outside = await tmpdir()
    const input = { script: script("x"), name: "x", directory: tmp.path, worktree: tmp.path, global: tmp.path }

    // .kilo itself is a symlink
    await fs.symlink(outside.path, path.join(tmp.path, ".kilo"))
    await expect(WorkflowSaved.save({ ...input, scope: "project" })).rejects.toThrow("symlink")
    await fs.rm(path.join(tmp.path, ".kilo"))

    // .kilo/workflows is a symlink
    await fs.mkdir(path.join(tmp.path, ".kilo"))
    await fs.symlink(outside.path, path.join(tmp.path, ".kilo", "workflows"))
    await expect(WorkflowSaved.save({ ...input, scope: "project" })).rejects.toThrow("symlink")
    await fs.rm(path.join(tmp.path, ".kilo", "workflows"))

    // the target file is a symlink (project and global)
    const victim = path.join(outside.path, "victim.txt")
    await Bun.write(victim, "keep")
    await fs.mkdir(path.join(tmp.path, ".kilo", "workflows"))
    await fs.symlink(victim, path.join(tmp.path, ".kilo", "workflows", "x.js"))
    await expect(WorkflowSaved.save({ ...input, scope: "project" })).rejects.toThrow("symlink")
    await fs.mkdir(path.join(tmp.path, "workflows"))
    await fs.symlink(victim, path.join(tmp.path, "workflows", "x.js"))
    await expect(WorkflowSaved.save({ ...input, scope: "global" })).rejects.toThrow("symlink")
    expect(await Bun.file(victim).text()).toBe("keep")
  })

  test("file names are derived from the meta name", () => {
    expect(WorkflowSaved.file("bug-hunt")).toBe("bug-hunt.js")
    expect(WorkflowSaved.file(" Deep Review ")).toBe("Deep-Review.js")
    expect(WorkflowSaved.file("../../etc/passwd")).toBe("etc-passwd.js")
    expect(() => WorkflowSaved.file("///")).toThrow()
  })

  test("each save bumps the revision", async () => {
    await using tmp = await tmpdir()
    const before = WorkflowSaved.revision()
    await WorkflowSaved.save({
      script: script("r"),
      name: "r",
      scope: "global",
      directory: tmp.path,
      worktree: tmp.path,
      global: tmp.path,
    })
    expect(WorkflowSaved.revision()).toBe(before + 1)
  })
})

describe("WorkflowSaved commands", () => {
  test("template is a short wrapper, never the script", () => {
    expect(WorkflowSaved.template("bug-hunt")).toBe(
      'Run the saved workflow "bug-hunt" by calling the workflow tool with name "bug-hunt". If the user supplied input below, pass it as the tool\'s `args` (as structured JSON when the workflow expects a list or object):\n\n$ARGUMENTS',
    )
  })

  const it = testEffect(
    Layer.mergeAll(AppNodeBuilder.build(Command.node), AppNodeBuilder.build(CrossSpawnSpawner.node)),
  )

  it.live("registers saved workflows as commands without shadowing existing ones", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const flows = path.join(dir, ".kilo", "workflows")
          yield* Effect.promise(async () => {
            await put(path.join(flows, "hunt.js"), script("bug-hunt", "Find bugs"))
            await put(path.join(flows, "init.js"), script("init", "Shadow attempt"))
            await put(path.join(flows, "spaced.js"), script("Deep Review", "Spaced name"))
            await put(path.join(flows, "danger.js"), script("x!`touch pwned`", "Shell in name"))
          })
          const commands = yield* Command.Service

          const hunt = yield* commands.get("bug-hunt")
          expect(hunt).toMatchObject({
            name: "bug-hunt",
            description: "Find bugs",
            source: "command",
            hints: ["$ARGUMENTS"],
            template: WorkflowSaved.template("bug-hunt"),
          })

          expect((yield* commands.get("init"))?.description).toBe("guided AGENTS.md setup")

          const spaced = yield* commands.get("spaced")
          expect(spaced?.template).toBe(WorkflowSaved.template("Deep Review"))

          const names = (yield* commands.list()).map((item) => item.name)
          expect(names).toContain("bug-hunt")
          expect(names.some((name) => name.includes("touch"))).toBe(false)

          // A workflow saved mid-session shows up without disposing the instance.
          yield* Effect.promise(() =>
            WorkflowSaved.save({
              script: script("fresh", "Saved later"),
              name: "fresh",
              scope: "project",
              directory: dir,
              worktree: dir,
              global: Global.Path.config,
            }),
          )
          expect((yield* commands.get("fresh"))?.description).toBe("Saved later")
          expect((yield* commands.list()).map((item) => item.name)).toContain("fresh")
        }),
      { git: true },
    ),
  )

  it.live("registers nothing when dynamic workflows are disabled", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => put(path.join(dir, ".kilo", "workflows", "hunt.js"), script("bug-hunt")))
          const commands = yield* Command.Service
          expect(yield* commands.get("bug-hunt")).toBeUndefined()
        }),
      { git: true, config: { experimental: { workflows: false } } },
    ),
  )
})

describe("workflow-authoring skill", () => {
  const it = testEffect(Layer.mergeAll(AppNodeBuilder.build(Skill.node), AppNodeBuilder.build(CrossSpawnSpawner.node)))
  const description =
    "Reference for writing a Workflow tool script (script API and gotchas, resume, quality patterns, worked examples). Load before authoring a script for a workflow the user already opted into; it does not itself authorize running one."

  it.live("ships as a built-in skill while workflows are enabled", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const item = yield* (yield* Skill.Service).get("workflow-authoring")
          expect(item?.location).toBe(Skill.BUILTIN_LOCATION)
          expect(item?.description).toBe(description)
          expect(item?.content).toContain("export const meta")
        }),
      { git: true },
    ),
  )

  it.live("is hidden when workflows are disabled", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const skills = yield* Skill.Service
          expect(yield* skills.get("workflow-authoring")).toBeUndefined()
          expect(yield* skills.get("kilo-config")).toBeDefined()
        }),
      { git: true, config: { experimental: { workflows: false } } },
    ),
  )

  it.live("a user skill with the name survives the disabled gate", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            put(
              path.join(dir, ".kilo", "skill", "workflow-authoring", "SKILL.md"),
              "---\nname: workflow-authoring\ndescription: Team notes.\n---\n\nOwn notes.\n",
            ),
          )
          const item = yield* (yield* Skill.Service).get("workflow-authoring")
          expect(item?.description).toBe("Team notes.")
        }),
      { git: true, config: { experimental: { workflows: false } } },
    ),
  )
})
