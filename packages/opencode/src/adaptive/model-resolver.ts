import { Catalog } from "@opencode-ai/core/catalog"
import { Credential } from "@opencode-ai/core/credential"
import { ModelV2 } from "@opencode-ai/core/model"
import { SessionRunnerModel } from "@opencode-ai/core/session/runner/model"
import { Effect } from "effect"
import type { Auth } from "@/auth"

export interface Input {
  readonly model: ModelV2.Ref
  readonly auth: Auth.Interface
}

export const resolveRef = Effect.fn("AdaptiveModelResolver.resolveRef")(function* (input: Input) {
  const models = yield* SessionRunnerModel.Service
  return yield* models.resolveRef({ model: input.model }).pipe(
    Effect.catchTag("SessionRunnerModel.ModelUnavailableError", (unavailable) =>
      Effect.gen(function* () {
        const legacy = yield* input.auth.get(input.model.providerID)
        if (legacy?.type !== "api") return yield* unavailable

        const catalog = yield* Catalog.Service
        const provider = yield* catalog.provider.get(input.model.providerID)
        const model = yield* catalog.model.get(input.model.providerID, input.model.id)
        if (!provider || provider.disabled || !model?.enabled) return yield* unavailable

        const credential = Credential.Key.make({
          type: "key",
          key: legacy.key,
          ...(legacy.metadata ? { metadata: legacy.metadata } : {}),
        })
        return yield* SessionRunnerModel.resolveModelRef(input.model, model, credential)
      }),
    ),
  )
})

export * as AdaptiveModelResolver from "./model-resolver"
