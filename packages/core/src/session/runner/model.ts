export * as SessionRunnerModel from "./model"

import { type Model } from "@opencode-ai/llm"
import * as AnthropicMessages from "@opencode-ai/llm/protocols/anthropic-messages"
import * as OpenAICompatibleChat from "@opencode-ai/llm/protocols/openai-compatible-chat"
import * as OpenAIResponses from "@opencode-ai/llm/protocols/openai-responses"
import { Auth, type AnyRoute } from "@opencode-ai/llm/route"
import { Context, Effect, Layer, Schema } from "effect"
import { produce } from "immer"
import { Catalog } from "../../catalog"
import { Credential } from "../../credential"
import { Integration } from "../../integration"
import { ModelV2 } from "../../model"
import { Npm } from "../../npm"
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

export class UnsupportedPackageError extends Schema.TaggedErrorClass<UnsupportedPackageError>()(
  "SessionRunnerModel.UnsupportedPackageError",
  {
    providerID: ProviderV2.ID,
    modelID: ModelV2.ID,
    package: Schema.String,
  },
) {
  override get message() {
    return `Unsupported package for ${this.providerID}/${this.modelID}: ${this.package}`
  }
}

export type Error =
  | ModelNotSelectedError
  | ModelUnavailableError
  | VariantUnavailableError
  | UnsupportedPackageError
  | Integration.AuthorizationError

export interface Interface {
  readonly resolve: (session: SessionSchema.Info) => Effect.Effect<Model, Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/SessionRunnerModel") {}

/** Test or embedding seam for supplying a model resolver directly. */
export const layerWith = (resolve: Interface["resolve"]) => Layer.succeed(Service, Service.of({ resolve }))

const apiKey = (model: ModelV2.Info, credential?: Credential.Value) => {
  if (credential?.type === "key") return Auth.value(credential.key)
  if (credential?.type === "oauth") return Auth.value(credential.access)
  const value = model.settings?.apiKey
  if (typeof value === "string") return Auth.value(value)
}

const withDefaults = (model: ModelV2.Info, route: AnyRoute) => {
  const body = model.body ?? {}
  const httpBody = Object.hasOwn(body, "apiKey")
    ? Object.fromEntries(Object.entries(body).filter(([key]) => key !== "apiKey"))
    : body
  return route.with({
    provider: model.providerID,
    endpoint: typeof model.settings?.baseURL === "string" ? { baseURL: model.settings.baseURL } : undefined,
    headers: model.headers,
    http: { body: httpBody },
    limits: { context: model.limit.context, output: model.limit.output },
  })
}

const withVariant = (
  model: ModelV2.Info,
  variantID: ModelV2.VariantID | undefined,
): Effect.Effect<ModelV2.Info, VariantUnavailableError> => {
  const id = variantID === "default" ? undefined : variantID
  const variant = model.variants?.find((item) => item.id === id)
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
          draft.settings = ProviderV2.mergeOverlay(draft.settings, variant.settings)
          draft.headers = ProviderV2.mergeHeaders(draft.headers, variant.headers)
          draft.body = ProviderV2.mergeOverlay(draft.body, variant.body)
        })
      : model,
  )
}

export const fromCatalogModel = (
  model: ModelV2.Info,
  credential?: Credential.Value,
  loadPackage: (
    specifier: string,
  ) => Effect.Effect<ProviderV2.ProviderPackage, ProviderV2.LoadError> = ProviderV2.loadPackage,
): Effect.Effect<Model, UnsupportedPackageError> => {
  const resolved =
    credential?.metadata === undefined
      ? model
      : produce(model, (draft) => {
          draft.settings = ProviderV2.mergeOverlay(draft.settings, credential.metadata)
        })
  const key = apiKey(resolved, credential)
  const packageName = ProviderV2.packageName(resolved.package)
  if (ProviderV2.isAISDK(resolved.package) && packageName === "@ai-sdk/openai") {
    return Effect.succeed(
      withDefaults(resolved, OpenAIResponses.route)
        .with({ auth: key === undefined ? Auth.none : Auth.bearer(key) })
        .model({ id: resolved.modelID ?? resolved.id }),
    )
  }
  if (ProviderV2.isAISDK(resolved.package) && packageName === "@ai-sdk/anthropic") {
    return Effect.succeed(
      withDefaults(resolved, AnthropicMessages.route)
        .with({ auth: key === undefined ? Auth.none : Auth.header("x-api-key", key) })
        .model({ id: resolved.modelID ?? resolved.id }),
    )
  }
  if (
    ProviderV2.isAISDK(resolved.package) &&
    packageName === "@ai-sdk/openai-compatible" &&
    typeof resolved.settings?.baseURL === "string"
  ) {
    return Effect.succeed(
      withDefaults(resolved, OpenAICompatibleChat.route)
        .with({ auth: key === undefined ? Auth.none : Auth.bearer(key) })
        .model({ id: resolved.modelID ?? resolved.id }),
    )
  }
  if (!ProviderV2.isAISDK(resolved.package) && resolved.package) {
    const specifier = resolved.package
    return Effect.gen(function* () {
      const module = yield* loadPackage(specifier).pipe(
        Effect.mapError(
          () =>
            new UnsupportedPackageError({
              providerID: resolved.providerID,
              modelID: resolved.id,
              package: specifier,
            }),
        ),
      )
      const settings = {
        ...resolved.settings,
        ...(credential?.type === "key" ? { apiKey: credential.key } : {}),
        ...(credential?.type === "oauth" ? { apiKey: credential.access } : {}),
        ...credential?.metadata,
        headers: resolved.headers,
        body: resolved.body,
        limits: { context: resolved.limit.context, output: resolved.limit.output },
      }
      return yield* Effect.try({
        try: () => ProviderV2.makeModel(module, resolved.modelID ?? resolved.id, settings),
        catch: () =>
          new UnsupportedPackageError({
            providerID: resolved.providerID,
            modelID: resolved.id,
            package: specifier,
          }),
      })
    })
  }
  return Effect.fail(
    new UnsupportedPackageError({
      providerID: resolved.providerID,
      modelID: resolved.id,
      package: resolved.package ?? "unknown",
    }),
  )
}

export const resolve = (
  session: SessionSchema.Info,
  model: ModelV2.Info,
  credential?: Credential.Value,
  loadPackage?: (specifier: string) => Effect.Effect<ProviderV2.ProviderPackage, ProviderV2.LoadError>,
) =>
  withVariant(model, session.model?.variant).pipe(
    Effect.flatMap((model) => fromCatalogModel(model, credential, loadPackage)),
  )

export const supported = (model: ModelV2.Info) =>
  Boolean(model.package) &&
  (!ProviderV2.isAISDK(model.package) ||
    ProviderV2.packageName(model.package) === "@ai-sdk/openai" ||
    ProviderV2.packageName(model.package) === "@ai-sdk/anthropic" ||
    (ProviderV2.packageName(model.package) === "@ai-sdk/openai-compatible" &&
      typeof model.settings?.baseURL === "string"))

/** Resolves models from the catalog belonging to the current Location runtime. */
export const locationLayer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const catalog = yield* Catalog.Service
    const integrations = yield* Integration.Service
    const npm = yield* Npm.Service
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
          (specifier) => ProviderV2.loadPackage(specifier, npm),
        )
      }),
    })
  }),
)
