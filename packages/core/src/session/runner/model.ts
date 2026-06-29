export * as SessionRunnerModel from "./model"

import { makeLocationNode } from "../../effect/app-node"
import { Model } from "@opencode-ai/llm"
import { Context, Effect, Layer, Schema } from "effect"
import { produce } from "immer"
import { AISDK } from "../../aisdk"
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

export interface Dependencies {
  readonly loadPackage?: (specifier: string) => Effect.Effect<ProviderV2.ProviderPackage, ProviderV2.LoadError>
  readonly loadAISDK?: (model: ModelV2.Info) => Effect.Effect<Model, AISDK.InitError>
}

const unsupported = (model: ModelV2.Info, packageName = model.package ?? "unknown") =>
  new UnsupportedPackageError({
    providerID: model.providerID,
    modelID: model.id,
    package: packageName,
  })

const credentialSettings = (credential: Credential.Value | undefined) => ({
  ...(credential?.type === "key" ? { apiKey: credential.key } : {}),
  ...(credential?.type === "oauth" ? { apiKey: credential.access } : {}),
  ...credential?.metadata,
})

export const fromCatalogModel = (
  model: ModelV2.Info,
  credential?: Credential.Value,
  dependencies: Dependencies = {},
): Effect.Effect<Model, UnsupportedPackageError> => {
  const resolved =
    credential?.metadata === undefined
      ? model
      : produce(model, (draft) => {
          draft.settings = ProviderV2.mergeOverlay(draft.settings, credential.metadata)
        })
  if (ProviderV2.isAISDK(resolved.package)) {
    if (!dependencies.loadAISDK) {
      return Effect.fail(unsupported(resolved))
    }
    const runtime = produce(resolved, (draft) => {
      draft.settings = ProviderV2.mergeOverlay(draft.settings, credentialSettings(credential))
    })
    return dependencies.loadAISDK(runtime).pipe(
      Effect.mapError(() => unsupported(resolved)),
    )
  }
  if (resolved.package) {
    const specifier = resolved.package
    return Effect.gen(function* () {
      const module = yield* (dependencies.loadPackage ?? ProviderV2.loadPackage)(specifier).pipe(
        Effect.mapError(() => unsupported(resolved, specifier)),
      )
      const settings = {
        ...resolved.settings,
        ...credentialSettings(credential),
        headers: resolved.headers,
        body: resolved.body,
        limits: { context: resolved.limit.context, output: resolved.limit.output },
      }
      return yield* Effect.try({
        try: () => Model.update(module.model(resolved.modelID ?? resolved.id, settings), { provider: resolved.providerID }),
        catch: () => unsupported(resolved, specifier),
      })
    })
  }
  return Effect.fail(unsupported(resolved))
}

export const resolve = (
  session: SessionSchema.Info,
  model: ModelV2.Info,
  credential?: Credential.Value,
  dependencies?: Dependencies,
) =>
  withVariant(model, session.model?.variant).pipe(
    Effect.flatMap((model) => fromCatalogModel(model, credential, dependencies)),
  )

export const supported = (model: ModelV2.Info) => Boolean(model.package)

/** Resolves models from the catalog belonging to the current Location runtime. */
export const locationLayer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const catalog = yield* Catalog.Service
    const integrations = yield* Integration.Service
    const npm = yield* Npm.Service
    const aisdk = yield* AISDK.Service
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
          {
            loadPackage: (specifier) => ProviderV2.loadPackage(specifier, npm),
            loadAISDK: (model) => aisdk.model(model),
          },
        )
      }),
    })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer: locationLayer,
  deps: [Catalog.node, Integration.node, Npm.node, AISDK.node],
})
