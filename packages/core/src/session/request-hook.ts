export * as SessionRequestHook from "./request-hook"

import type { LLMClientShape } from "@opencode-ai/ai/route"
import { Effect } from "effect"
import { PluginHooks } from "../plugin/hooks"
import { SessionSchema } from "./schema"

export const client = (llm: LLMClientShape, hooks: PluginHooks.Interface, sessionID: SessionSchema.ID) =>
  hooks.has("session", "request")
    ? llm.withRequestTransform((request) =>
        hooks.trigger("session", "request", { sessionID, request }).pipe(Effect.map((event) => event.request)),
      )
    : llm
