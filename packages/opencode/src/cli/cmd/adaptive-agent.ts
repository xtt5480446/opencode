import { cmd } from "./cmd"
import type { RoleContext } from "../../adaptive/process/agent-entry"

export async function runAdaptiveRole(context: RoleContext) {
  if (context.identity.role !== "coordinator") {
    await context.shutdown
    return
  }

  let bootstrap = ""
  await context.modelStream(null, (payload) => {
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return
    const event = payload as Record<string, unknown>
    if (event.type !== "text-delta" || typeof event.text !== "string") return
    bootstrap += event.text
  })
  await context.complete({ type: "bootstrap.completed", bootstrap })
}

export async function runAdaptiveAgent(argv: readonly string[]) {
  const { AgentEntry } = await import("../../adaptive/process/agent-entry")
  try {
    AgentEntry.parseArgv(argv)
  } catch {
    process.exitCode = AgentEntry.EXIT_PROTOCOL
    return
  }
  await AgentEntry.runStdio(runAdaptiveRole, argv)
}

export const AdaptiveAgentCommand = cmd({
  command: "__adaptive-agent",
  describe: false,
  builder: (yargs) =>
    yargs
      .option("task-id", { type: "string", demandOption: true })
      .option("agent-id", { type: "string", demandOption: true })
      .option("generation", { type: "string", demandOption: true })
      .option("role", { type: "string", demandOption: true }),
  async handler() {
    const index = process.argv.indexOf("__adaptive-agent")
    const argv = index === -1 ? [] : process.argv.slice(index + 1)
    await runAdaptiveAgent(argv)
  },
})
