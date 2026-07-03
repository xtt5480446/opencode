import { ProviderID, type ModelID } from "../schema"
import { OpenAICompatibleChat } from "../protocols/openai-compatible-chat"
import type { RouteDefaultsInput } from "../route/client"
import { AuthOptions, type ProviderAuthOption } from "../route/auth-options"
import { Auth } from "../route/auth"
import { ProviderPackage } from "../provider-package"

export const id = ProviderID.make("openai-compatible")

type GenericModelOptions = RouteDefaultsInput &
  ProviderAuthOption<"optional"> & {
    readonly provider?: string
    readonly baseURL: string
  }

export interface OpenAICompatibleSettings extends ProviderPackage.Settings {}

export const routes = [OpenAICompatibleChat.route]

export const configure = (input: GenericModelOptions) => {
  const provider = input.provider ?? "openai-compatible"
  const { provider: _, baseURL, apiKey: _apiKey, auth: _auth, ...rest } = input
  const route = OpenAICompatibleChat.route.with({
    ...rest,
    provider,
    endpoint: { baseURL },
    auth: AuthOptions.bearer(input, []),
  })
  return {
    id: ProviderID.make(provider),
    model: (modelID: string | ModelID) => route.model({ id: modelID, provider: ProviderID.make(provider) }),
    configure,
  }
}

export const model = ProviderPackage.define((modelID, settings: OpenAICompatibleSettings) =>
  OpenAICompatibleChat.route
    .with({
      auth: settings.apiKey === undefined ? Auth.none : Auth.bearer(settings.apiKey),
      endpoint: { baseURL: settings.baseURL },
      headers: settings.headers,
      providerOptions: settings.providerOptions && { openai: settings.providerOptions },
      http: { body: settings.body },
      limits: settings.limits,
    })
    .model({ id: modelID, provider: "openai-compatible" }),
)
