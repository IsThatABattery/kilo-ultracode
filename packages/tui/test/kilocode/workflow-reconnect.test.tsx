import { expect, test } from "bun:test"
import type { GlobalEvent } from "@kilocode/sdk/v2"
import { testRender } from "@opentui/solid"
import { Reconnect } from "@/kilocode/plugins/workflows"
import { SDKProvider } from "../../src/context/sdk"
import { wait } from "../cli/cmd/tui/sync-fixture"

// `api.event` filters by directory/project, which the synthesized `server.connected` lacks, so the workflows plugin
// reads the raw SDK stream to refetch capabilities after a reconnect to a possibly restarted server.
test("the workflows plugin refetches capabilities when the event stream (re)connects", async () => {
  const subscribed = Promise.withResolvers<(event: GlobalEvent) => void>()
  const events = {
    subscribe: async (handler: (event: GlobalEvent) => void) => {
      subscribed.resolve(handler)
      return () => {}
    },
  }
  const calls = { count: 0 }
  const refresh = async () => {
    calls.count++
  }
  const app = await testRender(() => (
    <SDKProvider url="http://test" events={events}>
      <Reconnect refresh={refresh} />
    </SDKProvider>
  ))
  try {
    const emit = await subscribed.promise
    emit({
      directory: "/repo",
      payload: { id: "evt_disposed", type: "server.instance.disposed", properties: { directory: "/repo" } },
    })
    await Bun.sleep(30)
    expect(calls.count).toBe(0)
    emit({ payload: { id: "evt_connected", type: "server.connected", properties: {} } } as GlobalEvent)
    await wait(() => calls.count === 1)
  } finally {
    app.renderer.destroy()
  }
})
