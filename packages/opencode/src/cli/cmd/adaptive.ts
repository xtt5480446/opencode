import type { Argv } from "yargs"
import { Effect, Schema } from "effect"
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { createHash, randomUUID } from "node:crypto"
import { sql } from "drizzle-orm"
import { AdaptiveModelAudit } from "@opencode-ai/core/adaptive/model-audit"
import { AdaptiveModelPolicy } from "@opencode-ai/core/adaptive/model-policy"
import { Database } from "@opencode-ai/core/database/database"
import { AdaptiveStore } from "@opencode-ai/core/adaptive/store"
import { AdaptiveTask } from "@opencode-ai/schema/adaptive-task"
import { AdaptiveController } from "@/adaptive/controller"
import { AgentProcessProtocol } from "@/adaptive/process/protocol"
import { AdaptiveProcessCommand } from "@/adaptive/process/command"
import { effectCmd, fail } from "../effect-cmd"

const json = (value: unknown) => process.stdout.write(JSON.stringify(value) + "\n")

const processSummary = (agent: AdaptiveStore.AgentRecord) => ({
  agentID: agent.id,
  role: agent.role,
  generation: agent.generation,
  state: agent.state,
  ...(agent.pid === undefined ? {} : { pid: agent.pid }),
  ...(agent.exitCode === undefined ? {} : { exitCode: agent.exitCode }),
  ...(agent.exitReason === undefined ? {} : { exitReason: agent.exitReason }),
})

const requestSummary = (request: AdaptiveStore.ModelRequestRecord) => ({
  requestID: request.id,
  agentID: request.agentID,
  generation: request.generation,
  manifestID: request.manifestID,
  ...(request.retryOf === undefined ? {} : { retryOf: request.retryOf }),
  status: request.status,
  providerID: request.resolved?.providerID ?? request.modelPolicy.providerID,
  modelID: request.resolved?.modelID ?? request.modelPolicy.modelID,
  ...((request.resolved?.variant ?? request.modelPolicy.variant)
    ? { variant: request.resolved?.variant ?? request.modelPolicy.variant }
    : {}),
  effectiveContextLimit: request.resolved?.effectiveContextLimit ?? request.modelPolicy.effectiveContextLimit,
  policyHash: request.modelPolicy.hash,
  ...(request.inputTokens === undefined ? {} : { inputTokens: request.inputTokens }),
  ...(request.outputTokens === undefined ? {} : { outputTokens: request.outputTokens }),
  ...(request.failure === undefined ? {} : { failure: request.failure }),
})

const taskSummary = Effect.fn("Cli.adaptive.taskSummary")(function* (taskID: AdaptiveTask.ID) {
  const store = yield* AdaptiveStore.Service
  const task = yield* store.getTask(taskID)
  const agents = yield* store.listAgents(task.id)
  const requests = yield* store.listModelRequests(task.id)
  const agent = agents.at(-1)
  const request = requests.at(-1)
  return {
    taskID: task.id,
    status: task.status,
    modelPolicy: task.modelPolicy,
    ...(agent ? { process: processSummary(agent) } : {}),
    ...(request ? { request: requestSummary(request) } : {}),
  }
})

const foundationChecks = Effect.fn("Cli.adaptive.foundationChecks")(function* () {
  const { db } = yield* Database.Service
  const tables = yield* db
    .all<{ name: string }>(
      sql`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name LIKE 'adaptive_%'
      ORDER BY name
    `,
    )
    .pipe(Effect.catch(() => fail("adaptive database migration unavailable")))
  const expectedTables = [
    "adaptive_agent_process",
    "adaptive_context_manifest",
    "adaptive_model_request",
    "adaptive_task",
  ]
  if (tables.map((row) => row.name).join("\n") !== expectedTables.join("\n"))
    return yield* fail("adaptive database migration unavailable")

  const auditColumns = yield* db
    .all<{ name: string }>(sql`PRAGMA table_info(adaptive_model_request)`)
    .pipe(Effect.catch(() => fail("adaptive audit schema unavailable")))
  const requiredAuditColumns = [
    "task_id",
    "agent_id",
    "generation",
    "manifest_id",
    "provider_id",
    "model_id",
    "model_policy_hash",
    "resolved_provider_id",
    "resolved_model_id",
    "resolved_effective_context_limit",
    "status",
  ]
  const availableColumns = new Set(auditColumns.map((column) => column.name))
  if (requiredAuditColumns.some((column) => !availableColumns.has(column)))
    return yield* fail("adaptive audit schema unavailable")

  const identity = {
    directory: process.cwd(),
    taskID: AdaptiveTask.ID.make(`adt_${"0".repeat(26)}`),
    agentID: AdaptiveTask.AgentID.make(`ada_${"0".repeat(26)}`),
    generation: 1,
    role: "coordinator" as const,
  }
  yield* Effect.try({
    try: () => {
      if (!existsSync(process.execPath)) throw new Error("runtime executable is missing")
      AdaptiveProcessCommand.options(identity)
    },
    catch: () => undefined,
  }).pipe(Effect.catch(() => fail("adaptive process command unavailable")))
  yield* AdaptiveProcessCommand.make(identity).pipe(
    Effect.asVoid,
    Effect.catch(() => fail("adaptive process command unavailable")),
  )

  yield* Effect.try({
    try: () => {
      const frame = {
        v: AgentProcessProtocol.VERSION,
        id: "doctor",
        type: "hello" as const,
        taskID: identity.taskID,
        agentID: identity.agentID,
        generation: identity.generation,
        role: identity.role,
      }
      const decoded = AgentProcessProtocol.decode(AgentProcessProtocol.encode(frame), "child-to-controller")
      if (decoded.type !== "hello" || decoded.id !== frame.id) throw new Error("protocol round trip failed")
    },
    catch: () => undefined,
  }).pipe(Effect.catch(() => fail("adaptive process protocol unavailable")))

  yield* Effect.try({
    try: () => {
      const target = join(process.cwd(), `.opencode-adaptive-doctor-${process.pid}-${randomUUID()}`)
      try {
        writeFileSync(target, "ok\n", { flag: "wx", mode: 0o600 })
      } finally {
        if (existsSync(target)) unlinkSync(target)
      }
    },
    catch: () => undefined,
  }).pipe(Effect.catch(() => fail("adaptive workspace is not writable")))

  return {
    database: "ok" as const,
    process: "ok" as const,
    workspace: "ok" as const,
    audit: "ok" as const,
    protocol: AgentProcessProtocol.VERSION,
  }
})

const ProcessEvidence = Schema.Struct({
  agentID: AdaptiveTask.AgentID,
  role: AdaptiveTask.Role,
  generation: Schema.Int,
  state: Schema.Literals(["idle", "starting", "running", "stopped", "lost", "failed"]),
  pid: Schema.optional(Schema.Int),
  exitCode: Schema.optional(Schema.Int),
  exitReason: Schema.optional(Schema.String),
})

const RequestEvidence = Schema.Struct({
  requestID: AdaptiveTask.RequestID,
  agentID: AdaptiveTask.AgentID,
  generation: Schema.Int,
  manifestID: AdaptiveTask.ContextManifestID,
  retryOf: Schema.optional(AdaptiveTask.RequestID),
  status: Schema.Literal("succeeded"),
  providerID: Schema.String,
  modelID: Schema.String,
  variant: Schema.optional(Schema.String),
  effectiveContextLimit: Schema.Int,
  policyHash: Schema.String,
  inputTokens: Schema.optional(Schema.Int),
  outputTokens: Schema.optional(Schema.Int),
  failure: Schema.optional(Schema.String),
})

const LiveDoctorEvidence = Schema.Struct({
  mode: Schema.Literal("live"),
  database: Schema.Literal("ok"),
  workspace: Schema.Literal("ok"),
  audit: Schema.Literal("ok"),
  protocol: Schema.Literal(AgentProcessProtocol.VERSION),
  taskID: AdaptiveTask.ID,
  modelPolicy: AdaptiveTask.ModelPolicy,
  process: ProcessEvidence,
  request: RequestEvidence,
  modelPolicyValid: Schema.Literal(true),
})
const decodeLiveDoctor = Schema.decodeUnknownSync(LiveDoctorEvidence)

const DoctorCommand = effectCmd({
  command: "doctor",
  describe: "check Adaptive Runtime foundation",
  instance: false,
  builder: (yargs: Argv) =>
    yargs
      .option("offline", { type: "boolean" })
      .option("live", { type: "boolean" })
      .option("model", { type: "string" })
      .option("json", { type: "boolean" }),
  handler: Effect.fn("Cli.adaptive.doctor")(function* (args) {
    if (args.offline && args.live) return yield* fail("adaptive doctor accepts only one of --offline or --live")
    if (args.live && !args.model) return yield* fail("adaptive doctor --live requires --model provider/model")
    if (!args.live && args.model) return yield* fail("adaptive doctor --model requires --live")
    const checks = yield* foundationChecks()
    if (!args.live) {
      const result = { mode: "offline" as const, ...checks }
      if (args.json) json(result)
      else process.stdout.write("Adaptive doctor: ok\n")
      return
    }

    const [providerID, ...modelParts] = args.model!.split("/")
    const modelID = modelParts.join("/")
    if (!providerID || !modelID) return yield* fail("adaptive doctor --model must use provider/model")
    const controller = yield* AdaptiveController.Service
    const started = yield* Effect.scoped(
      controller.start({
        directory: process.cwd(),
        requirement: "Verify the Adaptive Runtime execution boundary.",
        mode: "normal",
        requestedModel: { providerID, modelID },
      }),
    ).pipe(Effect.catch((error) => fail(error.message)))
    const summary = yield* taskSummary(started.taskID).pipe(
      Effect.catch(() => fail("adaptive live doctor state is unavailable")),
    )
    if (!summary.process || !summary.request || summary.request.status !== "succeeded")
      return yield* fail("adaptive live doctor did not complete one model request")
    const audit = yield* AdaptiveModelAudit.Service
    const proof = yield* audit.verify(started.taskID)
    if (
      !proof.valid ||
      proof.providerID !== started.modelPolicy.providerID ||
      proof.modelID !== started.modelPolicy.modelID ||
      proof.policyHash !== started.modelPolicy.hash ||
      proof.requests !== 1
    )
      return yield* fail("adaptive live doctor model policy is invalid")
    const result = {
      mode: "live" as const,
      database: checks.database,
      workspace: checks.workspace,
      audit: checks.audit,
      protocol: checks.protocol,
      taskID: started.taskID,
      modelPolicy: started.modelPolicy,
      process: summary.process,
      request: summary.request,
      modelPolicyValid: true as const,
    }
    if (args.json) json(result)
    else process.stdout.write(`Adaptive doctor: ok ${started.taskID}\n`)
  }),
})

const StatusCommand = effectCmd({
  command: "status <task-id>",
  describe: "show Adaptive task status",
  instance: false,
  builder: (yargs: Argv) =>
    yargs.positional("task-id", { type: "string", demandOption: true }).option("json", { type: "boolean" }),
  handler: Effect.fn("Cli.adaptive.status")(function* (args) {
    const result = yield* taskSummary(args["task-id"] as AdaptiveTask.ID).pipe(
      Effect.catch(() => fail("Adaptive task not found")),
    )
    if (args.json) json(result)
    else process.stdout.write(`${result.taskID} ${result.status}\n`)
  }),
})

const ExportCommand = effectCmd({
  command: "export",
  describe: "export Adaptive doctor evidence",
  instance: false,
  builder: (yargs: Argv) =>
    yargs
      .option("doctor", { type: "string", demandOption: true })
      .option("output", { type: "string", demandOption: true }),
  handler: Effect.fn("Cli.adaptive.export")(function* (args) {
    const source = yield* Effect.try({
      try: () => decodeLiveDoctor(JSON.parse(readFileSync(args.doctor, "utf8"))),
      catch: () => undefined,
    }).pipe(Effect.catch(() => fail("adaptive doctor evidence is invalid")))
    const store = yield* AdaptiveStore.Service
    const task = yield* store
      .getTask(source.taskID)
      .pipe(Effect.catch(() => fail("adaptive doctor evidence is invalid")))
    const agents = yield* store.listAgents(task.id)
    const requests = yield* store
      .listModelRequests(task.id)
      .pipe(Effect.catch(() => fail("adaptive doctor evidence is invalid")))
    const process = agents.at(-1)
    const request = requests.at(-1)
    const modelPolicyMatches = yield* Effect.sync(() => {
      try {
        AdaptiveModelPolicy.assertEqual(task.modelPolicy, source.modelPolicy)
        return true
      } catch {
        return false
      }
    })
    const audit = yield* AdaptiveModelAudit.Service
    const proof = yield* audit.verify(task.id)
    if (
      !modelPolicyMatches ||
      !process ||
      !request ||
      JSON.stringify(processSummary(process)) !== JSON.stringify(source.process) ||
      JSON.stringify(requestSummary(request)) !== JSON.stringify(source.request) ||
      !proof.valid ||
      proof.policyHash !== task.modelPolicy.hash ||
      proof.requests !== requests.length
    )
      return yield* fail("adaptive doctor evidence is invalid")

    const output = args.output
    if (existsSync(output)) return yield* fail("adaptive export output already exists")
    const files: Record<string, string> = {
      "doctor.json": JSON.stringify(source, null, 2) + "\n",
      "model-requests.jsonl": requests.map((item) => JSON.stringify(item)).join("\n") + "\n",
      "process.json": JSON.stringify({ taskID: task.id, processes: agents }, null, 2) + "\n",
    }
    const sums =
      Object.entries(files)
        .map(([name, value]) => `${createHash("sha256").update(value).digest("hex")}  ${name}`)
        .join("\n") + "\n"
    yield* Effect.try({
      try: () => {
        mkdirSync(output)
        for (const [name, value] of Object.entries(files))
          writeFileSync(join(output, name), value, { flag: "wx", mode: 0o600 })
        writeFileSync(join(output, "SHA256SUMS"), sums, { flag: "wx", mode: 0o600 })
      },
      catch: (cause) => cause,
    }).pipe(
      Effect.catch((cause) =>
        cause instanceof Error && "code" in cause && cause.code === "EEXIST"
          ? fail("adaptive export output already exists")
          : fail("adaptive export could not create evidence"),
      ),
    )
  }),
})

export const AdaptiveCommand = effectCmd({
  command: "adaptive",
  describe: "Adaptive Runtime management",
  instance: false,
  builder: (yargs: Argv) => yargs.command(DoctorCommand).command(StatusCommand).command(ExportCommand).demandCommand(),
  handler: Effect.fn("Cli.adaptive")(function* () {}),
})
