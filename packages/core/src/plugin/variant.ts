export * as VariantPlugin from "./variant"

import type { ModelV2Info } from "@opencode-ai/sdk/v2/types"
import { Effect } from "effect"
import { define } from "./internal"

export const Plugin = define({
  id: "variant",
  effect: Effect.fn(function* (ctx) {
    yield* ctx.catalog.transform((catalog) => {
      for (const record of catalog.provider.list()) {
        for (const model of record.models.values()) {
          catalog.model.update(model.providerID, model.id, (draft) => {
            const generated = generate(draft)
            if (generated.length === 0) return

            const explicit = new Map(draft.variants.map((variant) => [variant.id, variant]))
            const generatedIDs = new Set(generated.map((variant) => variant.id))
            draft.variants = [
              ...generated.map((variant) => explicit.get(variant.id) ?? variant),
              ...draft.variants.filter((variant) => !generatedIDs.has(variant.id)),
            ]
          })
        }
      }
    })
  }),
})

export function generate(model: ModelV2Info): ModelV2Info["variants"] {
  if (model.api.type !== "aisdk") return []

  if (model.api.package === "@ai-sdk/openai-compatible") {
    const ids = `${model.id} ${model.api.id}`.toLowerCase()
    if (["glm-5.2", "glm-5-2", "glm-5p2"].some((name) => ids.includes(name)))
      return ["high", "max"].map((id) => ({
        id,
        headers: {},
        body: { reasoning_effort: id },
      }))
    return []
  }

  if (model.api.package === "@ai-sdk/anthropic") return anthropicThinking(model)

  return []
}

// Anthropic thinking levels lower to the Messages API `thinking` body, which the
// v2 Anthropic protocol only accepts as `{ type: "enabled", budget_tokens }`.
// Budgets scale with the model output limit so the larger tier stays under the cap.
function anthropicThinking(model: ModelV2Info): ModelV2Info["variants"] {
  if (!model.capabilities.reasoning) return []
  const budget = (target: number) => Math.max(1024, Math.min(target, model.limit.output - 1))
  return [
    { id: "high", target: 16_000 },
    { id: "max", target: 31_999 },
  ].map((tier) => ({
    id: tier.id,
    headers: {},
    body: { thinking: { type: "enabled", budget_tokens: budget(tier.target) } },
  }))
}
