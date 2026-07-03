import type { RouteDefaultsInput } from "../route/client"
import { Auth } from "../route/auth"
import type { ProviderAuthOption } from "../route/auth-options"
import { ProviderID, type ModelID } from "../schema"
import { ProviderPackage } from "../provider-package"
import { AnthropicMessages } from "../protocols/anthropic-messages"

export const id = ProviderID.make("anthropic")

export const routes = [AnthropicMessages.route]

type Config = RouteDefaultsInput & ProviderAuthOption<"optional"> & { readonly baseURL?: string }

export interface AnthropicSettings extends ProviderPackage.Settings {}

const auth = (options: ProviderAuthOption<"optional">) => {
  if ("auth" in options && options.auth) return options.auth
  return Auth.optional("apiKey" in options ? options.apiKey : undefined, "apiKey")
    .orElse(Auth.config("ANTHROPIC_API_KEY"))
    .pipe(Auth.header("x-api-key"))
}

const configuredRoute = (input: Config) => {
  const { apiKey: _, auth: _auth, baseURL, ...rest } = input
  return AnthropicMessages.route.with({ ...rest, endpoint: { baseURL }, auth: auth(input) })
}

export const configure = (input: Config = {}) => {
  const route = configuredRoute(input)
  return {
    id,
    model: (modelID: string | ModelID) => route.model({ id: modelID }),
    configure,
  }
}

export const model = ProviderPackage.define((modelID, settings: AnthropicSettings) =>
  AnthropicMessages.route
    .with({
      auth: settings.apiKey === undefined ? Auth.none : Auth.header("x-api-key", settings.apiKey),
      endpoint: { baseURL: settings.baseURL },
      headers: settings.headers,
      providerOptions: settings.providerOptions && { anthropic: settings.providerOptions },
      http: { body: settings.body },
      limits: settings.limits,
    })
    .model({ id: modelID }),
)
