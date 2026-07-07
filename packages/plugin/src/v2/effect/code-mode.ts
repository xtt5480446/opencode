import type { Effect, Scope } from "effect"
import type { AnyTool, RegistrationError } from "./tool.js"

export type Path = readonly [string, ...string[]]

export interface Draft {
  add(path: Path, tool: AnyTool): void
}

export interface Domain {
  readonly register: (source: (draft: Draft) => void) => Effect.Effect<void, RegistrationError, Scope.Scope>
}
