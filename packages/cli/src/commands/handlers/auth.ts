import { EOL } from "os"
import * as Effect from "effect/Effect"
import { Commands } from "../commands"
import { Runtime } from "../../framework/runtime"
import { Daemon } from "../../services/daemon"

export default Runtime.handler(
  Commands.commands.auth,
  Effect.fn("cli.auth")(function* () {
    const daemon = yield* Daemon.Service
    const client = yield* daemon.client()
    const response = yield* Effect.promise(() =>
      client.v2.integration.list({ location: { directory: process.cwd() } }),
    )
    const connected = (response.data?.data ?? [])
      .filter((integration) => integration.connections.length > 0)
      .toSorted((a, b) => a.name.localeCompare(b.name))
    if (connected.length === 0) {
      process.stdout.write("No authenticated providers" + EOL)
      return
    }
    const width = Math.max(...connected.map((integration) => integration.name.length))
    const lines = connected.flatMap((integration) =>
      integration.connections.map(
        (connection) =>
          `${integration.name.padEnd(width)}  ${
            connection.type === "credential" ? `${connection.label} · credential` : `${connection.name} · env`
          }`,
      ),
    )
    process.stdout.write(lines.join(EOL) + EOL)
  }),
)
