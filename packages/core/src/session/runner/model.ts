export * as SessionRunnerModel from "./model"

import { makeLocationNode } from "../../effect/app-node"
import { Model } from "@opencode-ai/llm"
import { Context, Effect, Layer, Schema } from "effect"
import { produce } from "immer"
import { Catalog } from "../../catalog"
import { Credential } from "../../credential"
import { Integration } from "../../integration"
import { ModelV2 } from "../../model"
import { ProviderV2 } from "../../provider"
import { SessionSchema } from "../schema"

export class ModelNotSelectedError extends Schema.TaggedErrorClass<ModelNotSelectedError>()(
  "SessionRunnerModel.ModelNotSelectedError",
  {
    sessionID: SessionSchema.ID,
  },
) {
  override get message() {
    return `No model is available for session ${this.sessionID}`
  }
}

export class ModelUnavailableError extends Schema.TaggedErrorClass<ModelUnavailableError>()(
  "SessionRunnerModel.ModelUnavailableError",
  {
    providerID: ProviderV2.ID,
    modelID: ModelV2.ID,
  },
) {
  override get message() {
    return `Model unavailable: ${this.providerID}/${this.modelID}`
  }
}

export class VariantUnavailableError extends Schema.TaggedErrorClass<VariantUnavailableError>()(
  "SessionRunnerModel.VariantUnavailableError",
  {
    providerID: ProviderV2.ID,
    modelID: ModelV2.ID,
    variant: ModelV2.VariantID,
  },
) {
  override get message() {
    return `Variant unavailable for ${this.providerID}/${this.modelID}: ${this.variant}`
  }
}

export class UnsupportedApiError extends Schema.TaggedErrorClass<UnsupportedApiError>()(
  "SessionRunnerModel.UnsupportedApiError",
  {
    providerID: ProviderV2.ID,
    modelID: ModelV2.ID,
    api: Schema.String,
  },
) {
  override get message() {
    return `Unsupported API for ${this.providerID}/${this.modelID}: ${this.api}`
  }
}

export type Error =
  | ModelNotSelectedError
  | ModelUnavailableError
  | VariantUnavailableError
  | UnsupportedApiError
  | ProviderV2.PackageLoadError
  | Integration.AuthorizationError

export interface Interface {
  readonly resolve: (session: SessionSchema.Info) => Effect.Effect<Model, Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/SessionRunnerModel") {}

/** Test or embedding seam for supplying a model resolver directly. */
export const layerWith = (resolve: Interface["resolve"]) => Layer.succeed(Service, Service.of({ resolve }))

const withVariant = (
  model: ModelV2.Info,
  variantID: ModelV2.VariantID | undefined,
): Effect.Effect<ModelV2.Info, VariantUnavailableError> => {
  const id = variantID === "default" || variantID === undefined ? model.request.variant : variantID
  const variant = model.variants.find((item) => item.id === id)
  if (!variant && variantID !== undefined && variantID !== "default")
    return Effect.fail(
      new VariantUnavailableError({
        providerID: model.providerID,
        modelID: model.id,
        variant: variantID,
      }),
    )
  return Effect.succeed(
    variant
      ? produce(model, (draft) => {
          Object.assign(draft.request.headers, variant.headers)
          Object.assign(draft.request.body, variant.body)
        })
      : model,
  )
}

const apiName = (model: ModelV2.Info) =>
  model.api.type === "aisdk" ? `${model.api.type}:${model.api.package}` : model.api.type

export const fromCatalogModel = (
  model: ModelV2.Info,
  credential?: Credential.Value,
): Effect.Effect<Model, UnsupportedApiError | ProviderV2.PackageLoadError> => {
  const resolved =
    credential?.type !== "key" || credential.metadata === undefined
      ? model
      : produce(model, (draft) => {
          Object.assign(draft.request.body, credential.metadata)
        })
  return packageSpecifier(resolved).pipe(
    Effect.flatMap((specifier) =>
      ProviderV2.loadPackage(specifier).pipe(
        Effect.map((load) => {
          const selected = load(resolved.api.id ?? resolved.id, {
            ...resolved.api.settings,
            ...(credential?.type === "oauth" ? credential.metadata : undefined),
            baseURL: resolved.api.url ?? settingsString(resolved.api.settings, "baseURL"),
            apiKey: apiKey(resolved, credential),
            providerOptions: requestSettings(resolved.request),
            headers: resolved.request.headers,
            body: stripApiKey(resolved.request.body),
            limits: { context: resolved.limit.context, output: resolved.limit.output },
          })
          return Model.update(selected, {
            provider: resolved.providerID,
            route: selected.route.with({ provider: resolved.providerID }),
          })
        }),
      ),
    ),
  )
}

export const resolve = (session: SessionSchema.Info, model: ModelV2.Info, credential?: Credential.Value) =>
  withVariant(model, session.model?.variant).pipe(Effect.flatMap((model) => fromCatalogModel(model, credential)))

/** Legacy aisdk catalog entries dispatch to the equivalent native provider packages. */
const aisdkPackages: Record<string, string | undefined> = {
  "@ai-sdk/openai": "@opencode-ai/llm/providers/openai",
  "@ai-sdk/anthropic": "@opencode-ai/llm/providers/anthropic",
  "@ai-sdk/openai-compatible": "@opencode-ai/llm/providers/openai-compatible",
}

export const supported = (model: ModelV2.Info) =>
  (model.api.type === "native" && model.api.package !== undefined) ||
  (model.api.type === "aisdk" &&
    aisdkPackages[model.api.package] !== undefined &&
    // The openai-compatible package has no default endpoint; a URL is required.
    (model.api.package !== "@ai-sdk/openai-compatible" || model.api.url !== undefined))

const packageSpecifier = (model: ModelV2.Info): Effect.Effect<string, UnsupportedApiError> => {
  if (supported(model)) {
    if (model.api.type === "native" && model.api.package !== undefined) return Effect.succeed(model.api.package)
    const specifier = model.api.type === "aisdk" ? aisdkPackages[model.api.package] : undefined
    if (specifier !== undefined) return Effect.succeed(specifier)
  }
  return Effect.fail(
    new UnsupportedApiError({
      providerID: model.providerID,
      modelID: model.id,
      api: apiName(model),
    }),
  )
}

const apiKey = (model: ModelV2.Info, credential?: Credential.Value) => {
  if (credential?.type === "key") return credential.key
  if (credential?.type === "oauth") return credential.access
  const value = model.request.body.apiKey ?? model.api.settings?.apiKey
  if (typeof value === "string") return value
  return undefined
}

const stripApiKey = (body: ModelV2.Info["request"]["body"]) => {
  if (!Object.hasOwn(body, "apiKey")) return body
  return Object.fromEntries(Object.entries(body).filter(([key]) => key !== "apiKey"))
}

const requestSettings = (request: ModelV2.Info["request"]) => {
  if (!("settings" in request)) return undefined
  const settings = request.settings
  if (!isRecord(settings)) return undefined
  if (Object.keys(settings).length === 0) return undefined
  return settings
}

const settingsString = (settings: ModelV2.Info["api"]["settings"], key: string) => {
  const value = settings?.[key]
  if (typeof value === "string") return value
  return undefined
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Resolves models from the catalog belonging to the current Location runtime. */
export const locationLayer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const catalog = yield* Catalog.Service
    const integrations = yield* Integration.Service
    return Service.of({
      resolve: Effect.fn("SessionRunnerModel.resolve")(function* (session) {
        // Location plugins populate and filter the catalog asynchronously during layer startup.
        const defaultModel = session.model ? undefined : yield* catalog.model.default()
        const selected = session.model
          ? (yield* catalog.model.available()).find(
              (model) => model.providerID === session.model?.providerID && model.id === session.model.id,
            )
          : defaultModel && supported(defaultModel)
            ? defaultModel
            : (yield* catalog.model.available()).find(supported)
        if (!selected && session.model)
          return yield* new ModelUnavailableError({
            providerID: session.model.providerID,
            modelID: session.model.id,
          })
        if (!selected) return yield* new ModelNotSelectedError({ sessionID: session.id })
        const provider = yield* catalog.provider.get(selected.providerID)
        const connection = yield* integrations.connection.active(
          provider?.integrationID ?? Integration.ID.make(selected.providerID),
        )
        return yield* resolve(
          session,
          selected,
          connection ? yield* integrations.connection.resolve(connection) : undefined,
        )
      }),
    })
  }),
)

export const node = makeLocationNode({ service: Service, layer: locationLayer, deps: [Catalog.node, Integration.node] })
