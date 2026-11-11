// `kilo run` sends a prompt nobody typed into a client, so it must not count as the human-typed ultracode keyword
// (Claude Code excludes `-p` prompts the same way). The prompt part carries a headless origin stamp for that check.

import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { createKiloClient } from "@kilocode/sdk/v2"
import { cliIt } from "../../lib/cli-process"

describe("kilo run headless prompt origin", () => {
  cliIt.live(
    "stamps the prompt text part as headless so the keyword does not opt in",
    ({ llm, opencode }) =>
      Effect.gen(function* () {
        const server = yield* opencode.serve()
        const client = createKiloClient({ baseUrl: server.url })
        const session = yield* Effect.promise(() => client.session.create({}))
        const id = session.data?.id
        expect(id).toBeDefined()

        yield* llm.text("explained")
        const result = yield* opencode.run("explain what the experimental.ultracode setting does", {
          extraArgs: ["--attach", server.url, "--session", id!],
        })
        opencode.expectExit(result, 0)

        const messages = yield* Effect.promise(() => client.session.messages({ sessionID: id! }))
        const user = messages.data?.find((msg) => msg.info.role === "user")
        const part = user?.parts
          .filter((item) => item.type === "text")
          .find((item) => item.text.includes("experimental.ultracode"))
        expect(part?.metadata?.kilo).toEqual({ origin: "headless" })
        // The word in a headless prompt is not an opt-in, so the model never sees the keyword reminder.
        const input = JSON.stringify(yield* llm.inputs)
        expect(input).toContain("explain what the experimental.ultracode setting does")
        expect(input).not.toContain("explicit opt-in to multi-agent orchestration for this task")
      }),
    60_000,
  )
})
