export * as ProviderV2 from "./provider"

import { Effect, Schema } from "effect"
import { pathToFileURL } from "url"
import { Provider } from "@opencode-ai/schema/provider"
import type { ProviderPackageDefinition } from "@opencode-ai/llm"
import { Npm } from "./npm"
import type { DeepMutable } from "./schema"

export const ID = Provider.ID
export type ID = typeof ID.Type

export const AISDK_PREFIX = "aisdk:"
export const isAISDK = (packageName: string | undefined) => packageName?.startsWith(AISDK_PREFIX) ?? false
export const aisdk = (packageName: string) => (isAISDK(packageName) ? packageName : `${AISDK_PREFIX}${packageName}`)
export const packageName = (packageName: string | undefined) =>
  isAISDK(packageName) ? packageName!.slice(AISDK_PREFIX.length) : packageName

export class LoadError extends Schema.TaggedErrorClass<LoadError>()("ProviderV2.LoadError", {
  package: Schema.String,
  cause: Schema.Defect(),
}) {}
export type ProviderPackage = ProviderPackageDefinition

const packages = new Map<string, Promise<unknown>>()

export const loadPackage = Effect.fn("ProviderV2.loadPackage")(function* (specifier: string, npm?: Npm.Interface) {
  const resolved = yield* resolvePackage(specifier)
  if (resolved) return yield* importPackage(specifier, resolved)
  if (!npm) {
    return yield* new LoadError({
      package: specifier,
      cause: new Error(`Provider package ${specifier} is not installed`),
    })
  }
  const installed = yield* npm
    .add(rootPackage(specifier))
    .pipe(Effect.mapError((cause) => new LoadError({ package: specifier, cause })))
  const entrypoint = yield* Effect.try({
    try: () => import.meta.resolve(specifier, pathToFileURL(`${installed.directory}/`).href),
    catch: (cause) => new LoadError({ package: specifier, cause }),
  })
  return yield* importPackage(specifier, entrypoint)
})

export function mergeOverlay(
  base: Readonly<Record<string, unknown>> | undefined,
  overlay: Readonly<Record<string, unknown>> | undefined,
): Record<string, unknown> | undefined {
  if (base === undefined) return overlay && { ...overlay }
  if (overlay === undefined) return { ...base }
  return Object.fromEntries(
    new Set([...Object.keys(base), ...Object.keys(overlay)]).values().map((key) => {
      const left = base[key]
      const right = overlay[key]
      if (right === undefined) return [key, left]
      if (
        typeof left === "object" &&
        left !== null &&
        !Array.isArray(left) &&
        typeof right === "object" &&
        right !== null &&
        !Array.isArray(right)
      )
        return [
          key,
          mergeOverlay(left as Readonly<Record<string, unknown>>, right as Readonly<Record<string, unknown>>),
        ]
      return [key, right]
    }),
  )
}

export function mergeHeaders(
  base: Readonly<Record<string, string>> | undefined,
  overlay: Readonly<Record<string, string>> | undefined,
) {
  if (base === undefined) return overlay && { ...overlay }
  if (overlay === undefined) return { ...base }
  return Object.fromEntries(
    [...Object.entries(base), ...Object.entries(overlay)]
      .reduce((result, entry) => {
        result.set(entry[0].toLowerCase(), entry)
        return result
      }, new Map<string, [string, string]>())
      .values(),
  )
}

export const Request = Provider.Request
export type Request = Provider.Request

export const Info = Provider.Info
export type Info = Provider.Info

export type MutableInfo = DeepMutable<Info>

const resolvePackage = (specifier: string) =>
  Effect.sync(() => {
    if (specifier.startsWith("file://") || specifier.startsWith("@opencode-ai/llm/")) return specifier
    try {
      return import.meta.resolve(specifier)
    } catch {
      return undefined
    }
  })

const importPackage = Effect.fn("ProviderV2.importPackage")(function* (specifier: string, entrypoint: string) {
  const module = yield* Effect.tryPromise({
    try: () => {
      const existing = packages.get(entrypoint)
      if (existing) return existing
      const loaded = import(entrypoint)
      packages.set(entrypoint, loaded)
      return loaded
    },
    catch: (cause) => new LoadError({ package: specifier, cause }),
  })
  if (!isProviderPackage(module)) {
    return yield* new LoadError({
      package: specifier,
      cause: new Error(`Provider package ${specifier} does not export model(modelID, settings)`),
    })
  }
  return module
})

function isProviderPackage(input: unknown): input is ProviderPackageDefinition {
  return typeof input === "object" && input !== null && "model" in input && typeof input.model === "function"
}

function rootPackage(specifier: string) {
  const parts = specifier.split("/")
  if (specifier.startsWith("@")) return parts.slice(0, 2).join("/")
  return parts[0]
}
