import { AdaptiveTask } from "@opencode-ai/schema/adaptive-task"
import { Duration, Effect } from "effect"
import { ChildProcess } from "effect/unstable/process"

export interface Input {
  readonly directory: string
  readonly taskID: AdaptiveTask.ID
  readonly agentID: AdaptiveTask.AgentID
  readonly generation: number
  readonly role: AdaptiveTask.Role
}

const allowed = new Set([
  "PATH",
  "Path",
  "COMSPEC",
  "ComSpec",
  "SYSTEMROOT",
  "SystemRoot",
  "WINDIR",
  "PATHEXT",
  "HOME",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
  "NO_COLOR",
  "OPENCODE_DISABLE_AUTOUPDATE",
  "OPENCODE_DISABLE_MODELS_FETCH",
  "OPENCODE_DISABLE_DEFAULT_PLUGINS",
  "OPENCODE_DISABLE_PROJECT_CONFIG",
  "OPENCODE_DISABLE_EXTERNAL_SKILLS",
  "OPENCODE_DISABLE_SHARE",
  "OPENCODE_PURE",
])
const sensitive = /KEY|TOKEN|SECRET|PASSWORD|AUTH|CREDENTIAL|COOKIE/i

export function environment(source: NodeJS.ProcessEnv = process.env) {
  return Object.fromEntries(
    Object.entries(source)
      .filter((entry): entry is [string, string] => {
        if (!allowed.has(entry[0]) || entry[1] === undefined) return false
        return !sensitive.test(entry[0])
      })
      .toSorted(([left], [right]) => left.localeCompare(right)),
  )
}

export function agentArgs(input: Input) {
  return [
    "--task-id",
    input.taskID,
    "--agent-id",
    input.agentID,
    "--generation",
    String(input.generation),
    "--role",
    input.role,
  ]
}

export function options(input: Input) {
  return {
    cwd: input.directory,
    env: environment(),
    extendEnv: false,
    stdin: "pipe" as const,
    stdout: "pipe" as const,
    stderr: "pipe" as const,
    detached: process.platform !== "win32",
    forceKillAfter: Duration.seconds(3),
  }
}

export const make = Effect.fn("AdaptiveProcessCommand.make")(function* (input: Input) {
  const source = process.argv[1]?.endsWith(".ts") === true
  const args = source
    ? ["run", "--conditions=browser", process.argv[1]!, "__adaptive-agent", ...agentArgs(input)]
    : ["__adaptive-agent", ...agentArgs(input)]
  return ChildProcess.make(process.execPath, args, options(input))
})

export * as AdaptiveProcessCommand from "./command"
