import { cmd } from "./cmd"

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
    const { AgentEntry } = await import("../../adaptive/process/agent-entry")
    AgentEntry.parseArgv(argv)
    await AgentEntry.runStdio(async (context) => {
      await context.shutdown
    }, argv)
  },
})
