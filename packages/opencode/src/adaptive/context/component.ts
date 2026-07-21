export * as AdaptiveContextComponent from "./component"

import { Token } from "@/util/token"

export type Priority = "mandatory" | "strong" | "requested" | "ephemeral"

export type Kind =
  | "role-instructions"
  | "requirement"
  | "roadmap"
  | "assignment"
  | "contract"
  | "detail"
  | "checkpoint"
  | "workspace"
  | "failed-validation"
  | "risk"
  | "repo-map"
  | "tool-event"
  | "local-tail"

export interface Component {
  readonly key: string
  readonly kind: Kind
  readonly priority: Priority
  readonly sourceRevision: string
  readonly text: string
  readonly estimatedTokens: number
  readonly evictable: boolean
}

export type Input = Omit<Component, "estimatedTokens">

export class DuplicateKeyError extends Error {
  constructor(readonly key: string) {
    super(`Duplicate Adaptive context component key: ${key}`)
  }
}

export function create(input: readonly Input[]): readonly Component[] {
  const keys = new Set<string>()
  return input.map((component) => {
    if (keys.has(component.key)) throw new DuplicateKeyError(component.key)
    keys.add(component.key)
    return { ...component, estimatedTokens: Token.estimate(component.text) }
  })
}
