import { Route, type RoutePatch, type RouteRoutedModelInput } from "../route/client"
import type { Auth as AuthDef } from "../route/auth"
import { Endpoint } from "../route/endpoint"
import { Framing } from "../route/framing"
import type { Model, ProviderOptions } from "../schema"
import * as OpenAIChat from "./openai-chat"

const ADAPTER = "openai-compatible-chat"

export type OpenAICompatibleChatModelInput = RouteRoutedModelInput

/**
 * Route for non-OpenAI providers that expose an OpenAI Chat-compatible
 * `/chat/completions` endpoint. Reuses `OpenAIChat.protocol` end-to-end and
 * overrides only the route id so providers can be resolved per-family without
 * colliding with native OpenAI. Provider helpers configure the route endpoint
 * before model selection.
 */
export const route = Route.make({
  id: ADAPTER,
  protocol: OpenAIChat.protocol,
  endpoint: Endpoint.path("/chat/completions"),
  framing: Framing.sse,
})

export interface ModelConfig {
  readonly auth: AuthDef
  readonly baseURL?: string
  readonly headers?: Readonly<Record<string, string>>
  readonly providerOptions?: ProviderOptions
  readonly body?: Readonly<Record<string, unknown>>
  readonly limits?: { readonly context: number; readonly output: number }
}

export const model = (id: string, config: ModelConfig): Model =>
  route
    .with({
      auth: config.auth,
      endpoint: config.baseURL === undefined ? undefined : { baseURL: config.baseURL },
      headers: config.headers,
      providerOptions: config.providerOptions,
      http: config.body === undefined ? undefined : { body: config.body },
      limits: config.limits,
    } satisfies RoutePatch<OpenAIChat.OpenAIChatBody, unknown>)
    .model({ id, provider: "openai-compatible" })

export * as OpenAICompatibleChat from "./openai-compatible-chat"
