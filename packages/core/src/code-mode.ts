export * as CodeModeV2 from "./code-mode"

import type { CodeMode } from "@opencode-ai/plugin/v2/effect"
import { Context, Effect, Layer, Scope } from "effect"
import { makeLocationNode } from "./effect/app-node"
import { Flag } from "./flag/flag"
import { PermissionV2 } from "./permission"
import { ExecuteTool } from "./code-mode/execute"
import { permission, RegistrationError, type AnyTool } from "./tool/tool"
import { Wildcard } from "./util/wildcard"

type Registration = {
  readonly identity: object
  readonly tool: AnyTool
  readonly name: string
  readonly path: readonly [string, ...string[]]
}

export interface MaterializeInput {
  readonly permissions?: PermissionV2.Ruleset
}

export interface Interface {
  readonly enabled: boolean
  readonly register: (
    source: (draft: CodeMode.Draft) => void,
  ) => Effect.Effect<void, RegistrationError, Scope.Scope>
  readonly materialize: (input: MaterializeInput) => Effect.Effect<AnyTool | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/CodeMode") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const enabled = Flag.CODEMODE_ENABLED
    const local = new Map<string, Array<{ readonly token: object; readonly registration: Registration }>>()

    return Service.of({
      enabled,
      register: Effect.fn("CodeMode.register")(function* (source) {
        const pending: Array<{ readonly path: readonly [string, ...string[]]; readonly tool: AnyTool }> = []
        yield* Effect.sync(() =>
          source({
            add: (path, tool) => pending.push({ path, tool }),
          }),
        )
        if (pending.length === 0) return

        const entries = pending.map((entry) => ({
          ...entry,
          key: entry.path.join("\0"),
          name: entry.path.join("_"),
        }))
        const invalid = entries.find((entry) => entry.path.some((segment) => segment.length === 0))
        if (invalid)
          return yield* new RegistrationError({
            name: invalid.path.join("."),
            message: "Code Mode paths cannot contain empty segments",
          })
        const keys = new Set<string>()
        const duplicate = entries.find((entry) => {
          if (keys.has(entry.key)) return true
          keys.add(entry.key)
          return false
        })
        if (duplicate)
          return yield* new RegistrationError({
            name: duplicate.path.join("."),
            message: `Duplicate Code Mode path: ${duplicate.path.join(".")}`,
          })

        yield* Effect.uninterruptible(
          Effect.gen(function* () {
            const token = {}
            for (const entry of entries)
              local.set(entry.key, [
                ...(local.get(entry.key) ?? []),
                {
                  token,
                  registration: {
                    identity: {},
                    tool: entry.tool,
                    name: entry.name,
                    path: entry.path,
                  },
                },
              ])
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                for (const entry of entries) {
                  const registrations = local.get(entry.key)?.filter((item) => item.token !== token) ?? []
                  if (registrations.length > 0) local.set(entry.key, registrations)
                  else local.delete(entry.key)
                }
              }),
            )
          }),
        )
      }),
      materialize: Effect.fn("CodeMode.materialize")(function* (input) {
        if (!enabled || whollyDisabled("execute", input.permissions ?? [])) return undefined
        const registrations = new Map<string, Registration>()
        for (const [key, entries] of local) {
          const registration = entries.at(-1)?.registration
          if (
            registration &&
            !whollyDisabled(permission(registration.tool, registration.name), input.permissions ?? [])
          )
            registrations.set(key, registration)
        }
        if (registrations.size === 0) return undefined
        return ExecuteTool.create({
          registrations,
          current: (key) => local.get(key)?.at(-1)?.registration,
        })
      }),
    })
  }),
)

function whollyDisabled(action: string, rules: PermissionV2.Ruleset) {
  const rule = rules.findLast((rule) => Wildcard.match(action, rule.action))
  return rule?.resource === "*" && rule.effect === "deny"
}

export const node = makeLocationNode({ service: Service, layer, deps: [] })
