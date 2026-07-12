import { Service } from "@opencode-ai/client/effect"
import { Cause, Effect } from "effect"

const RED_BOLD = "\x1b[91m\x1b[1m"
const BOLD = "\x1b[1m"
const RESET = "\x1b[0m"

export function handle(cause: Cause.Cause<unknown>, command: string) {
  const error = Cause.squash(cause)
  if (!(error instanceof Service.StartError)) return Effect.failCause(cause)
  return Effect.gen(function* () {
    yield* Effect.logError("background service startup failed", { cause: Cause.pretty(cause) })
    yield* Effect.sync(() => {
      process.stderr.write(render(error, command))
      process.exitCode = 1
    })
  })
}

export function render(error: Service.StartError, command: string) {
  const detail =
    error.stage === "spawn"
      ? "The service process could not be started."
      : error.stage === "registration"
        ? "The service exited or never became ready.\nThe expected registration file was not created."
        : "The service started but did not become ready."
  return `\n${RED_BOLD}OpenCode could not start its background service${RESET}\n\n${detail}\n\n${BOLD}Try:${RESET}\n  ${command} service restart\n  OPENCODE_LOG_LEVEL=DEBUG ${command}\n`
}

export * as StartupError from "./startup-error"
