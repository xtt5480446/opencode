import fs from "fs"
import path from "path"

const DefaultPath = "/tmp/opencode-simulation.log"

let reportedFailure = false

export function filePath() {
  return process.env.OPENCODE_SIMULATION_LOG || DefaultPath
}

export function add(type: string, data?: unknown) {
  if (!process.env.OPENCODE_SIMULATION) return
  try {
    const output = filePath()
    fs.mkdirSync(path.dirname(output), { recursive: true })
    fs.appendFileSync(
      output,
      JSON.stringify({
        time: new Date().toISOString(),
        pid: process.pid,
        type,
        ...(data === undefined ? {} : { data: sanitize(data) }),
      }) + "\n",
    )
  } catch (error) {
    if (reportedFailure) return
    reportedFailure = true
    process.stderr.write(`opencode simulation log failed: ${error instanceof Error ? error.message : String(error)}\n`)
  }
}

function sanitize(input: unknown): unknown {
  try {
    JSON.stringify(input)
    return input
  } catch {
    return String(input)
  }
}

export * as SimulationLog from "./log"
