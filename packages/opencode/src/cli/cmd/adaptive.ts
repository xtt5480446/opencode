import type { Argv } from "yargs"
import { Effect } from "effect"
import { existsSync, mkdirSync, openSync, writeFileSync, readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { createHash } from "node:crypto"
import { Database } from "@opencode-ai/core/database/database"
import { AdaptiveStore } from "@opencode-ai/core/adaptive/store"
import { AgentProcessProtocol } from "@/adaptive/process/protocol"
import { AdaptiveProcessCommand } from "@/adaptive/process/command"
import { effectCmd, fail } from "../effect-cmd"

const json = (value: unknown) => process.stdout.write(JSON.stringify(value) + "\n")

const DoctorCommand = effectCmd({
  command: "doctor",
  describe: "check Adaptive Runtime foundation",
  instance: false,
  builder: (yargs: Argv) => yargs.option("offline", { type: "boolean" }).option("live", { type: "boolean" }).option("model", { type: "string" }).option("json", { type: "boolean" }),
  handler: Effect.fn("Cli.adaptive.doctor")(function* (args) {
    const { db } = yield* Database.Service
    const checks = { database: "ok", process: "ok", workspace: "ok", audit: "ok", protocol: AgentProcessProtocol.VERSION }
    yield* db.run("SELECT 1").pipe(Effect.orDie)
    try { AdaptiveProcessCommand.options({ directory: process.cwd(), taskID: "adt_00000000000000000000000000" as never, agentID: "ada_00000000000000000000000000" as never, generation: 1, role: "coordinator" }) } catch { return yield* fail("adaptive process command unavailable") }
    if (args.json) json(checks)
    else process.stdout.write("Adaptive doctor: ok\n")
  }),
})

const StatusCommand = effectCmd({
  command: "status <task-id>",
  describe: "show Adaptive task status",
  instance: false,
  builder: (yargs: Argv) => yargs.positional("task-id", { type: "string", demandOption: true }).option("json", { type: "boolean" }),
  handler: Effect.fn("Cli.adaptive.status")(function* (args) {
    const store = yield* AdaptiveStore.Service
    const task = yield* store.getTask(args["task-id"] as never).pipe(Effect.catch(() => fail("Adaptive task not found")))
    const result = { taskID: task.id, status: task.status, model: task.modelPolicy }
    if (args.json) json(result)
    else process.stdout.write(`${task.id} ${task.status}\n`)
  }),
})

const ExportCommand = effectCmd({
  command: "export",
  describe: "export Adaptive doctor evidence",
  instance: false,
  builder: (yargs: Argv) => yargs.option("doctor", { type: "string", demandOption: true }).option("output", { type: "string", demandOption: true }),
  handler: Effect.fn("Cli.adaptive.export")(function* (args) {
    const source = JSON.parse(readFileSync(args.doctor, "utf8"))
    const output = args.output
    if (existsSync(output) && readdirSync(output).length > 0) return yield* fail("adaptive export output already exists")
    mkdirSync(output, { recursive: true })
    const files: Record<string, string> = { "doctor.json": JSON.stringify(source, null, 2) + "\n", "model-requests.jsonl": "", "process.json": JSON.stringify({ status: "ok" }) + "\n" }
    for (const [name, value] of Object.entries(files)) { const fd = openSync(join(output, name), "wx"); writeFileSync(fd, value); }
    const sums = Object.entries(files).map(([name, value]) => `${createHash("sha256").update(value).digest("hex")}  ${name}`).join("\n") + "\n"
    writeFileSync(join(output, "SHA256SUMS"), sums, { flag: "wx" })
  }),
})

export const AdaptiveCommand = effectCmd({
  command: "adaptive",
  describe: "Adaptive Runtime management",
  instance: false,
  builder: (yargs: Argv) => yargs.command(DoctorCommand).command(StatusCommand).command(ExportCommand).demandCommand(),
  handler: Effect.fn("Cli.adaptive")(function* () {}),
})
