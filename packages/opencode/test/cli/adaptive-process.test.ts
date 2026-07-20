import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { cliIt } from "../lib/cli-process"
import { raw } from "../lib/llm-server"

describe("opencode adaptive runtime subprocess", () => {
  cliIt.concurrent(
    "offline doctor reports foundation checks without a legacy session",
    ({ llm, opencode }) =>
      Effect.gen(function* () {
        const result = yield* opencode.spawn(["adaptive", "doctor", "--offline", "--json"])
        opencode.expectExit(result, 0)
        const body = JSON.parse(result.stdout)
        expect(body.mode).toBe("offline")
        expect(body.database).toBe("ok")
        expect(body.process).toBe("ok")
        expect(body.workspace).toBe("ok")
        expect(body.audit).toBe("ok")
        expect(body.protocol).toBe(1)
        expect(yield* llm.calls).toBe(0)
      }),
    30_000,
  )

  cliIt.concurrent(
    "adaptive formatted output names one durable Task and creates no legacy Session",
    ({ llm, opencode }) =>
      Effect.gen(function* () {
        yield* llm.text("Repository discovery is not required.")
        const result = yield* opencode.run("inspect", { runtime: "adaptive" })
        opencode.expectExit(result, 0)

        const taskIDs = result.stdout.match(/adt_[0-9A-Za-z]{26}/g) ?? []
        expect(taskIDs).toHaveLength(1)
        const counts = yield* opencode.spawn([
          "db",
          "SELECT (SELECT COUNT(*) FROM session) AS sessions, (SELECT COUNT(*) FROM adaptive_task) AS tasks",
          "--format",
          "json",
        ])
        opencode.expectExit(counts, 0)
        expect(JSON.parse(counts.stdout)).toEqual([{ sessions: 0, tasks: 1 }])
      }),
    30_000,
  )

  cliIt.concurrent(
    "adaptive resolves --dir before persisting and starting the child",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        const workspace = join(home, "workspace")
        mkdirSync(workspace)
        yield* llm.text("Repository discovery is not required.", { usage: { input: 8, output: 3 } })

        const result = yield* opencode.run("inspect", {
          runtime: "adaptive",
          format: "json",
          extraArgs: ["--dir", workspace],
        })
        opencode.expectExit(result, 0)
        const taskID = opencode.parseJsonEvents(result.stdout)[0]?.taskID
        const task = yield* opencode.spawn([
          "db",
          `SELECT directory FROM adaptive_task WHERE id = '${taskID}'`,
          "--format",
          "json",
        ])
        opencode.expectExit(task, 0)
        expect(JSON.parse(task.stdout)).toEqual([{ directory: workspace }])
      }),
    30_000,
  )

  cliIt.concurrent(
    "adaptive rejects every legacy Session control before creating durable state",
    ({ llm, opencode }) =>
      Effect.gen(function* () {
        const cases = [
          { name: "continue", args: ["--continue"] },
          { name: "session", args: ["--session", "ses_test"] },
          { name: "fork", args: ["--fork"] },
          { name: "command", args: ["--command", "review"] },
          { name: "share", args: ["--share"] },
          { name: "attach", args: ["--attach", "http://127.0.0.1:1"] },
          { name: "interactive", args: ["--interactive"] },
          { name: "file", args: ["--file", "missing.txt"] },
        ] as const

        for (const item of cases) {
          const result = yield* opencode.spawn([
            "run",
            "--runtime",
            "adaptive",
            "--model",
            "test/test-model",
            ...item.args,
            "inspect",
          ])
          expect(result.exitCode).not.toBe(0)
          expect(result.stderr).toContain(`--runtime adaptive cannot be combined with --${item.name}`)
        }
        expect(yield* llm.calls).toBe(0)
        const tasks = yield* opencode.spawn(["db", "SELECT COUNT(*) AS count FROM adaptive_task", "--format", "json"])
        opencode.expectExit(tasks, 0)
        expect(JSON.parse(tasks.stdout)).toEqual([{ count: 0 }])
      }),
    30_000,
  )

  cliIt.live(
    "adaptive rejects legacy controls before draining open stdin",
    ({ opencode }) =>
      Effect.gen(function* () {
        const run = yield* opencode.startRun("inspect", {
          runtime: "adaptive",
          keepStdinOpen: true,
          extraArgs: ["--session", "ses_test"],
        })
        const result = yield* run.result.pipe(
          Effect.timeoutOrElse({
            duration: "2 seconds",
            orElse: () => Effect.fail(new Error("adaptive validation waited for stdin EOF")),
          }),
        )

        expect(result.exitCode).not.toBe(0)
        expect(result.stderr).toContain("--runtime adaptive cannot be combined with --session")
      }),
    5_000,
  )

  cliIt.concurrent(
    "adaptive run completes one audited child model request",
    ({ llm, opencode }) =>
      Effect.gen(function* () {
        yield* llm.text("Repository discovery is required.", { usage: { input: 17, output: 4 } })
        const result = yield* opencode.run("inspect", { runtime: "adaptive", format: "json" })
        const events = opencode.parseJsonEvents(result.stdout)
        opencode.expectExit(result, 0)
        expect(events[0]).toMatchObject({ type: "adaptive.task.created", status: "planning" })
        const taskID = events[0]?.taskID
        expect(taskID).toMatch(/^adt_[0-9A-Za-z]{26}$/)
        expect(events.every((event) => event.taskID === taskID)).toBe(true)
        expect(events.at(-1)).toMatchObject({
          type: "adaptive.bootstrap.completed",
          taskID,
          bootstrap: "Repository discovery is required.",
        })
        expect(yield* llm.calls).toBe(1)

        const status = yield* opencode.spawn(["adaptive", "status", String(taskID), "--json"])
        opencode.expectExit(status, 0)
        expect(JSON.parse(status.stdout)).toMatchObject({
          taskID,
          status: "planning",
          bootstrap: {
            output: "Repository discovery is required.",
            requestID: expect.stringMatching(/^adr_[0-9A-Za-z]{26}$/),
          },
          process: { role: "coordinator", generation: 1, state: "stopped", exitCode: 0 },
          request: {
            status: "succeeded",
            providerID: "test",
            modelID: "test-model",
            inputTokens: 17,
            outputTokens: 4,
          },
        })
      }),
    30_000,
  )

  cliIt.concurrent(
    "adaptive bootstrap rejects a model stream that ends without finish",
    ({ llm, opencode }) =>
      Effect.gen(function* () {
        yield* llm.push(
          raw({
            chunks: [
              {
                id: "chatcmpl-unfinished",
                object: "chat.completion.chunk",
                choices: [{ delta: { role: "assistant" } }],
              },
              {
                id: "chatcmpl-unfinished",
                object: "chat.completion.chunk",
                choices: [{ delta: { content: "partial" } }],
              },
            ],
          }),
        )

        const result = yield* opencode.run("inspect", { runtime: "adaptive", format: "json" })
        expect(result.exitCode).not.toBe(0)
        const events = opencode.parseJsonEvents(result.stdout)
        expect(events).toHaveLength(1)
        expect(events[0]).toMatchObject({ type: "adaptive.task.created", status: "planning" })

        const status = yield* opencode.spawn(["adaptive", "status", String(events[0]?.taskID), "--json"])
        opencode.expectExit(status, 0)
        expect(JSON.parse(status.stdout)).toMatchObject({ request: { status: "failed" } })
        expect(JSON.parse(status.stdout)).not.toHaveProperty("bootstrap")
      }),
    30_000,
  )

  cliIt.concurrent(
    "adaptive bootstrap rejects a successful model stream without text",
    ({ llm, opencode }) =>
      Effect.gen(function* () {
        yield* llm.push(
          raw({
            chunks: [
              {
                id: "chatcmpl-empty",
                object: "chat.completion.chunk",
                choices: [{ delta: { role: "assistant" } }],
              },
              {
                id: "chatcmpl-empty",
                object: "chat.completion.chunk",
                choices: [{ delta: {}, finish_reason: "stop" }],
              },
            ],
          }),
        )

        const result = yield* opencode.run("inspect", { runtime: "adaptive", format: "json" })
        expect(result.exitCode).not.toBe(0)
        const events = opencode.parseJsonEvents(result.stdout)
        expect(events).toHaveLength(1)
        expect(events[0]).toMatchObject({ type: "adaptive.task.created", status: "planning" })

        const status = yield* opencode.spawn(["adaptive", "status", String(events[0]?.taskID), "--json"])
        opencode.expectExit(status, 0)
        expect(JSON.parse(status.stdout)).toMatchObject({ request: { status: "succeeded" } })
        expect(JSON.parse(status.stdout)).not.toHaveProperty("bootstrap")
      }),
    30_000,
  )

  cliIt.concurrent(
    "adaptive run fails instead of fabricating a task id when model resolution fails",
    ({ opencode }) =>
      Effect.gen(function* () {
        const result = yield* opencode.run("inspect", {
          runtime: "adaptive",
          format: "json",
          model: "test/missing-model",
        })
        expect(result.exitCode).not.toBe(0)
        expect(result.stdout).not.toContain("adt_unavailable")
        expect(result.stderr).toContain("Adaptive model is unavailable")
      }),
    30_000,
  )

  cliIt.concurrent(
    "live doctor uses the Controller path and reports policy-valid durable evidence",
    ({ llm, opencode }) =>
      Effect.gen(function* () {
        yield* llm.text("Repository discovery is not required.", { usage: { input: 21, output: 6 } })
        const result = yield* opencode.spawn(["adaptive", "doctor", "--live", "--model", "test/test-model", "--json"])
        opencode.expectExit(result, 0)
        const body = JSON.parse(result.stdout)

        expect(body).toMatchObject({
          mode: "live",
          database: "ok",
          process: {
            role: "coordinator",
            generation: 1,
            state: "stopped",
            exitCode: 0,
          },
          workspace: "ok",
          audit: "ok",
          protocol: 1,
          modelPolicy: {
            providerID: "test",
            modelID: "test-model",
            effectiveContextLimit: 100_000,
          },
          request: {
            status: "succeeded",
            providerID: "test",
            modelID: "test-model",
            inputTokens: 21,
            outputTokens: 6,
          },
          modelPolicyValid: true,
        })
        expect(body.taskID).toMatch(/^adt_[0-9A-Za-z]{26}$/)
        expect(yield* llm.calls).toBe(1)
      }),
    30_000,
  )

  cliIt.concurrent(
    "export validates live doctor evidence and writes real create-new artifacts",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        yield* llm.text("Repository discovery is required.", { usage: { input: 13, output: 5 } })
        const doctor = yield* opencode.spawn(["adaptive", "doctor", "--live", "--model", "test/test-model", "--json"])
        opencode.expectExit(doctor, 0)
        const doctorBody = JSON.parse(doctor.stdout)
        const doctorPath = join(home, "g1-doctor.json")
        const output = join(home, "g1-evidence")
        writeFileSync(doctorPath, doctor.stdout)

        const exported = yield* opencode.spawn(["adaptive", "export", "--doctor", doctorPath, "--output", output])
        opencode.expectExit(exported, 0)
        expect(JSON.parse(readFileSync(join(output, "doctor.json"), "utf8"))).toEqual(doctorBody)

        const requestLines = readFileSync(join(output, "model-requests.jsonl"), "utf8").trim().split("\n")
        expect(requestLines).toHaveLength(1)
        expect(JSON.parse(requestLines[0])).toMatchObject({
          taskID: doctorBody.taskID,
          status: "succeeded",
          modelPolicy: { providerID: "test", modelID: "test-model" },
          resolved: { providerID: "test", modelID: "test-model", effectiveContextLimit: 100_000 },
          inputTokens: 13,
          outputTokens: 5,
        })
        const processBody = JSON.parse(readFileSync(join(output, "process.json"), "utf8"))
        expect(processBody).toMatchObject({
          taskID: doctorBody.taskID,
          processes: [{ role: "coordinator", generation: 1, state: "stopped", exitCode: 0 }],
        })

        const sums = readFileSync(join(output, "SHA256SUMS"), "utf8").trim().split("\n")
        expect(sums).toHaveLength(3)
        for (const line of sums) {
          const match = line.match(/^([0-9a-f]{64})  (doctor\.json|model-requests\.jsonl|process\.json)$/)
          expect(match).not.toBeNull()
          const content = readFileSync(join(output, match![2]))
          expect(createHash("sha256").update(content).digest("hex")).toBe(match![1])
        }

        const repeated = yield* opencode.spawn(["adaptive", "export", "--doctor", doctorPath, "--output", output])
        expect(repeated.exitCode).not.toBe(0)
        expect(repeated.stderr).toContain("adaptive export output already exists")

        const empty = join(home, "existing-empty-evidence")
        mkdirSync(empty)
        const emptyResult = yield* opencode.spawn(["adaptive", "export", "--doctor", doctorPath, "--output", empty])
        expect(emptyResult.exitCode).not.toBe(0)
        expect(emptyResult.stderr).toContain("adaptive export output already exists")

        const invalidDoctor = join(home, "invalid-doctor.json")
        const invalidOutput = join(home, "invalid-evidence")
        writeFileSync(invalidDoctor, JSON.stringify({ database: "ok" }))
        const invalid = yield* opencode.spawn([
          "adaptive",
          "export",
          "--doctor",
          invalidDoctor,
          "--output",
          invalidOutput,
        ])
        expect(invalid.exitCode).not.toBe(0)
        expect(invalid.stderr).toContain("adaptive doctor evidence is invalid")
        expect(existsSync(invalidOutput)).toBe(false)
      }),
    30_000,
  )
})
