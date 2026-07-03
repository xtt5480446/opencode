import { AuthOptions, type ProviderAuthOption } from "../route/auth-options"
import { Auth } from "../route/auth"
import type { Route, RouteDefaultsInput } from "../route/client"
import { ProviderID, type ModelID } from "../schema"
import { ProviderPackage } from "../provider-package"
import { OpenAIChat } from "../protocols/openai-chat"
import { OpenAIResponses } from "../protocols/openai-responses"
import { withOpenAIOptions, type OpenAIProviderOptionsInput } from "./openai-options"

export type { OpenAIOptionsInput, OpenAIResponseIncludable } from "./openai-options"

export const id = ProviderID.make("openai")

export const routes = [OpenAIResponses.route, OpenAIResponses.webSocketRoute, OpenAIChat.route]

// This provider facade wraps the lower-level Responses and Chat model factories
// with OpenAI-specific conveniences: typed options, API-key sugar, env fallback,
// and default option normalization.
type Config = RouteDefaultsInput &
  ProviderAuthOption<"optional"> & {
    readonly baseURL?: string
    readonly queryParams?: Record<string, string>
    readonly providerOptions?: OpenAIProviderOptionsInput
  }

export interface OpenAISettings extends ProviderPackage.Settings {}

const auth = (options: ProviderAuthOption<"optional">) => AuthOptions.bearer(options, "OPENAI_API_KEY")

const defaults = (input: Config) => {
  const { apiKey: _, auth: _auth, baseURL: _baseURL, queryParams: _queryParams, ...rest } = input
  return rest
}

const configuredRoute = <Body, Prepared>(route: Route<Body, Prepared>, input: Config) =>
  route.with({
    auth: auth(input),
    endpoint: { baseURL: input.baseURL, query: input.queryParams },
  })

export const configure = (input: Config = {}) => {
  const responsesRoute = configuredRoute(OpenAIResponses.route, input)
  const responsesWebSocketRoute = configuredRoute(OpenAIResponses.webSocketRoute, input)
  const chatRoute = configuredRoute(OpenAIChat.route, input)
  const modelDefaults = defaults(input)
  const responses = (id: string | ModelID) =>
    responsesRoute.with(withOpenAIOptions(id, modelDefaults, { textVerbosity: true })).model({ id })
  const responsesWebSocket = (id: string | ModelID) =>
    responsesWebSocketRoute.with(withOpenAIOptions(id, modelDefaults, { textVerbosity: true })).model({ id })
  const chat = (id: string | ModelID) => chatRoute.with(withOpenAIOptions(id, modelDefaults)).model({ id })

  return {
    id,
    model: responses,
    responses,
    responsesWebSocket,
    chat,
    configure,
  }
}

export const model = ProviderPackage.define((modelID, settings: OpenAISettings) =>
  OpenAIResponses.route
    .with({
      auth: settings.apiKey === undefined ? Auth.none : Auth.bearer(settings.apiKey),
      endpoint: { baseURL: settings.baseURL },
      headers: settings.headers,
      providerOptions: settings.providerOptions && { openai: settings.providerOptions },
      http: { body: settings.body },
      limits: settings.limits,
    })
    .model({ id: modelID }),
)
