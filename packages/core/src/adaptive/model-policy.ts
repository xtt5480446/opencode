export * as AdaptiveModelPolicy from "./model-policy"

import { AdaptiveTask } from "@opencode-ai/schema/adaptive-task"
import { Hash } from "../util/hash"

export type Input = Omit<AdaptiveTask.ModelPolicy, "hash">

const canonical = (input: Input) =>
  JSON.stringify({
    providerID: input.providerID,
    modelID: input.modelID,
    ...(input.variant === undefined ? {} : { variant: input.variant }),
    effectiveContextLimit: input.effectiveContextLimit,
    outputReserve: input.outputReserve,
    safetyReserve: input.safetyReserve,
  })

const digest = (value: string) => `sha256:${Hash.sha256(value)}`

export const create = (input: Input) =>
  AdaptiveTask.ModelPolicy.make({
    ...input,
    hash: digest(canonical(input)),
  })

export function assertEqual(expected: AdaptiveTask.ModelPolicy, actual: AdaptiveTask.ModelPolicy) {
  const expectedCanonical = canonical(expected)
  const actualCanonical = canonical(actual)
  if (
    expected.hash === digest(expectedCanonical) &&
    actual.hash === digest(actualCanonical) &&
    expected.hash === actual.hash &&
    expectedCanonical === actualCanonical
  )
    return
  throw new Error(`Adaptive ModelPolicy mismatch: expected ${expected.hash}, received ${actual.hash}`)
}
