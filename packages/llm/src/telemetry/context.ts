import { Effect, Option } from "effect"
import type { Span } from "effect/Tracer"
import { ATTR_OPENCODE_LLM_ROUTE } from "../semconv"

export const currentModelSpan = Effect.option(Effect.currentSpan).pipe(
  Effect.map(Option.getOrUndefined),
  Effect.map(findModelSpan),
)

function findModelSpan(span: Span | undefined): Span | undefined {
  if (!span) return
  if (span.attributes.has(ATTR_OPENCODE_LLM_ROUTE)) return span
  const parent = Option.getOrUndefined(span.parent)
  return findModelSpan(parent?._tag === "Span" ? parent : undefined)
}
