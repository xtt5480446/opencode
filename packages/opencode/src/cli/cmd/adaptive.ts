import type { Argv } from "yargs"
import { Effect, Option, Schema } from "effect"
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { createHash, randomUUID } from "node:crypto"
import { sql } from "drizzle-orm"
import { AdaptiveModelAudit } from "@opencode-ai/core/adaptive/model-audit"
import { AdaptiveModelPolicy } from "@opencode-ai/core/adaptive/model-policy"
import { Database } from "@opencode-ai/core/database/database"
import { AdaptiveStore } from "@opencode-ai/core/adaptive/store"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { AppProcess } from "@opencode-ai/core/process"
import { AdaptiveTask } from "@opencode-ai/schema/adaptive-task"
import { AdaptiveController } from "@/adaptive/controller"
import { AdaptiveEvidence } from "@/adaptive/evidence"
import { AgentEntry } from "@/adaptive/process/agent-entry"
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
  const bootstrap = Option.getOrUndefined(yield* store.getBootstrap(task.id).pipe(Effect.option))
  const agent = agents.at(-1)
  const request = requests.at(-1)
  return {
    taskID: task.id,
    status: task.status,
    modelPolicy: task.modelPolicy,
    ...(bootstrap ? { bootstrap } : {}),
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
    "adaptive_bootstrap",
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
    role: "discovery" as const,
  }
  const command = yield* AdaptiveProcessCommand.make(identity).pipe(
    Effect.catch(() => fail("adaptive process command unavailable")),
  )
  const accepted = AgentProcessProtocol.encode({
    v: AgentProcessProtocol.VERSION,
    id: "doctor-accepted",
    type: "accepted",
    heartbeatMs: 5_000,
  })
  const shutdown = AgentProcessProtocol.encode({
    v: AgentProcessProtocol.VERSION,
    id: "doctor-shutdown",
    type: "shutdown",
    reason: "Adaptive offline doctor completed",
  })
  const child = yield* (yield* AppProcess.Service)
    .run(command, {
      stdin: Buffer.concat([accepted, shutdown]),
      timeout: "5 seconds",
      maxOutputBytes: 64 * 1024,
      maxErrorBytes: 64 * 1024,
    })
    .pipe(Effect.catch(() => fail("adaptive process command unavailable")))
  // Discovery has no completion RPC; the intentional shutdown is therefore a protocol stop.
  if (child.exitCode !== AgentEntry.EXIT_PROTOCOL || child.stdoutTruncated || child.stderrTruncated)
    return yield* fail("adaptive process command unavailable")
  yield* Effect.try({
    try: () => {
      const decoder = AgentProcessProtocol.makeDecoder("child-to-controller")
      const frames = decoder.push(child.stdout)
      decoder.finish()
      const [hello, ready] = frames
      if (
        frames.length !== 2 ||
        hello?.type !== "hello" ||
        hello.taskID !== identity.taskID ||
        hello.agentID !== identity.agentID ||
        hello.generation !== identity.generation ||
        hello.role !== identity.role ||
        ready?.type !== "ready"
      )
        throw new Error("adaptive child handshake failed")
    },
    catch: () => undefined,
  }).pipe(Effect.catch(() => fail("adaptive process command unavailable")))

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

const BootstrapEvidence = Schema.Struct({
  taskID: AdaptiveTask.ID,
  agentID: AdaptiveTask.AgentID,
  generation: Schema.Int,
  manifestID: AdaptiveTask.ContextManifestID,
  requestID: AdaptiveTask.RequestID,
  output: Schema.String,
  timeCreated: Schema.Int,
})

const LiveDoctorEvidence = Schema.Struct({
  mode: Schema.Literal("live"),
  database: Schema.Literal("ok"),
  workspace: Schema.Literal("ok"),
  audit: Schema.Literal("ok"),
  protocol: Schema.Literal(AgentProcessProtocol.VERSION),
  taskID: AdaptiveTask.ID,
  modelPolicy: AdaptiveTask.ModelPolicy,
  bootstrap: BootstrapEvidence,
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
    if (!summary.bootstrap || !summary.process || !summary.request || summary.request.status !== "succeeded")
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
      bootstrap: summary.bootstrap,
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
    const bootstrap = Option.getOrUndefined(yield* store.getBootstrap(task.id).pipe(Effect.option))
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
      !bootstrap ||
      !process ||
      !request ||
      JSON.stringify(bootstrap) !== JSON.stringify(source.bootstrap) ||
      JSON.stringify(processSummary(process)) !== JSON.stringify(source.process) ||
      JSON.stringify(requestSummary(request)) !== JSON.stringify(source.request) ||
      !proof.valid ||
      proof.policyHash !== task.modelPolicy.hash ||
      proof.requests !== requests.length
    )
      return yield* fail("adaptive doctor evidence is invalid")

    const files: Record<string, string> = {
      "doctor.json": JSON.stringify(source, null, 2) + "\n",
      "model-requests.jsonl": requests.map((item) => JSON.stringify(item)).join("\n") + "\n",
      "process.json": JSON.stringify({ taskID: task.id, processes: agents }, null, 2) + "\n",
    }
    const sums =
      Object.entries(files)
        .map(([name, value]) => `${createHash("sha256").update(value).digest("hex")}  ${name}`)
        .join("\n") + "\n"
    const fs = yield* FSUtil.Service
    yield* AdaptiveEvidence.write(fs, args.output, { ...files, SHA256SUMS: sums }).pipe(
      Effect.catchTag("AdaptiveEvidence.WriteError", (error) =>
        error.reason === "exists"
          ? fail("adaptive export output already exists")
          : error.reason === "cleanup"
            ? fail("adaptive export could not clean incomplete evidence")
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
