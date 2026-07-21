export * as AdaptiveContextRequest from "./request"

import { Hash } from "@opencode-ai/core/util/hash"
import { Token } from "@opencode-ai/core/util/token"
import { AdaptiveTask } from "@opencode-ai/schema/adaptive-task"
import { SystemPart } from "@opencode-ai/llm"

export interface Input<Messages extends readonly unknown[], Tools extends readonly unknown[]> {
  readonly taskID: AdaptiveTask.ID
  readonly modelPolicy: AdaptiveTask.ModelPolicy
  readonly roadmapRevision: number
  readonly system: readonly string[]
  readonly messages: Messages
  readonly tools: Tools
}

export interface Prepared<Messages extends readonly unknown[], Tools extends readonly unknown[]> {
  readonly promptCacheKey: string
  readonly system: readonly SystemPart[]
  readonly messages: Messages
  readonly tools: Tools
  readonly providerOptions: { readonly openai: { readonly promptCacheKey: string } }
  readonly generation: { readonly maxTokens: number }
  readonly estimatedTokens: number
  readonly requestHash: string
}

export function prepare<Messages extends readonly unknown[], Tools extends readonly unknown[]>(
  input: Input<Messages, Tools>,
): Prepared<Messages, Tools> {
  const promptCacheKey = `adaptive:${input.taskID}:roadmap:${input.roadmapRevision}`
  const system = input.system.map(SystemPart.make)
  const providerOptions = { openai: { promptCacheKey } } as const
  const generation = { maxTokens: input.modelPolicy.outputReserve } as const
  const serialized = stableJson({
    model: {
      providerID: input.modelPolicy.providerID,
      modelID: input.modelPolicy.modelID,
      ...(input.modelPolicy.variant === undefined ? {} : { variant: input.modelPolicy.variant }),
      policyHash: input.modelPolicy.hash,
    },
    system,
    messages: input.messages,
    tools: input.tools,
    providerOptions,
    generation,
  })
  return {
    promptCacheKey,
    system,
    messages: input.messages,
    tools: input.tools,
    providerOptions,
    generation,
    estimatedTokens: Token.estimate(serialized),
    requestHash: `sha256:${Hash.sha256(serialized)}`,
  }
}

function stableJson(input: unknown): string {
  return JSON.stringify(stableValue(input))
}

function stableValue(input: unknown): unknown {
  if (input === null || typeof input === "string" || typeof input === "boolean") return input
  if (typeof input === "number") return input
  if (Array.isArray(input)) return input.map(stableValue)
  if (typeof input !== "object") return undefined
  const descriptors = Object.getOwnPropertyDescriptors(input)
  const output: Record<string, unknown> = Object.create(null)
  for (const key of Object.keys(descriptors).sort()) {
    const descriptor = descriptors[key]
    if (!descriptor || !("value" in descriptor)) return undefined
    const nested = stableValue(descriptor.value)
    if (nested !== undefined) output[key] = nested
  }
  return output
}
