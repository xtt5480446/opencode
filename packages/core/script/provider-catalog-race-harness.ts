import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { DateTime, Effect, Layer } from "effect"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { LayerNode } from "../src/effect/layer-node"
import { Database } from "../src/database/database"
import { EventV2 } from "../src/event"
import { Catalog } from "../src/catalog"
import { Location } from "../src/location"
import { LocationServiceMap } from "../src/location-services"
import { ModelV2 } from "../src/model"
import { ProjectV2 } from "../src/project"
import { ProviderV2 } from "../src/provider"
import { AbsolutePath } from "../src/schema"
import { SessionV2 } from "../src/session"
import { SessionRunnerModel } from "../src/session/runner/model"

export type Delay = "none" | "yield" | "1ms" | "10ms"

export interface Scenario {
  id: string
  delay: Delay
  providerID: string
  modelID: string
  configuredDefault: boolean
  apiKey: boolean
  disabled: boolean
  repeats: number
}

export interface Snapshot {
  attempt: number
  providers: string[]
  models: string[]
  availableModels: string[]
  resolved?: { providerID: string; modelID: string }
  error?: { tag: string; message: string }
}

export interface Result {
  scenario: Scenario
  directory: string
  snapshots: Snapshot[]
  reproduced: boolean
}

const app = AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, LocationServiceMap.node]))

export async function runScenario(scenario: Scenario, root?: string): Promise<Result> {
  const directory = root ?? (await fs.mkdtemp(path.join(os.tmpdir(), "opencode-provider-race-")))
  await fs.mkdir(directory, { recursive: true })
  await fs.writeFile(path.join(directory, "opencode.json"), JSON.stringify(config(scenario), undefined, 2) + "\n")
  const location = Location.Ref.make({ directory: AbsolutePath.make(directory) })

  const program = Effect.gen(function* () {
    const locations = yield* LocationServiceMap.Service
    const context = yield* locations.contextEffect(location)
    const output: Snapshot[] = []
    for (let attempt = 0; attempt < scenario.repeats; attempt++) {
      yield* delay(scenario.delay)
      output.push(
        yield* Effect.gen(function* () {
          const catalog = yield* Catalog.Service
          const providers = (yield* catalog.provider.all()).map((item) => item.id).sort()
          const models = (yield* catalog.model.all()).map((item) => `${item.providerID}/${item.id}`).sort()
          const availableModels = (yield* catalog.model.available())
            .map((item) => `${item.providerID}/${item.id}`)
            .sort()
          const resolved = yield* SessionRunnerModel.Service.use((service) =>
            service.resolve(session(scenario, location)),
          ).pipe(
            Effect.map((item) => ({ providerID: String(item.ref.providerID), modelID: String(item.ref.id) })),
            Effect.catch((error) =>
              Effect.succeed({
                error: {
                  tag: typeof error === "object" && error && "_tag" in error ? String(error._tag) : "Unknown",
                  message: error instanceof Error ? error.message : String(error),
                },
              }),
            ),
          )
          return {
            attempt,
            providers,
            models,
            availableModels,
            ...(resolved && "error" in resolved ? { error: resolved.error } : { resolved }),
          }
        }).pipe(Effect.provide(context)),
      )
    }
    return output
  }).pipe(Effect.scoped, Effect.provide(app))
  const snapshots = await Effect.runPromise(program)

  const expected = `${scenario.providerID}/${scenario.modelID}`
  return {
    scenario,
    directory,
    snapshots,
    reproduced: snapshots.some(
      (item) => !item.models.includes(expected) || item.error?.tag === "SessionRunnerModel.ModelUnavailableError",
    ),
  }
}

function config(scenario: Scenario) {
  return {
    ...(scenario.configuredDefault ? { model: `${scenario.providerID}/${scenario.modelID}` } : {}),
    providers: {
      [scenario.providerID]: {
        name: `Probe ${scenario.providerID}`,
        api: { type: "aisdk", package: "@ai-sdk/openai-compatible", url: "https://probe.invalid/v1" },
        request: { body: scenario.apiKey ? { apiKey: "probe-key" } : {} },
        models: {
          [scenario.modelID]: {
            name: `Probe ${scenario.modelID}`,
            disabled: scenario.disabled,
            capabilities: { tools: true, input: ["text"], output: ["text"] },
            limit: { context: 8192, output: 2048 },
          },
        },
      },
    },
  }
}

function session(scenario: Scenario, location: Location.Ref) {
  return SessionV2.Info.make({
    id: SessionV2.ID.make(`ses_${scenario.id.replace(/[^a-zA-Z0-9_-]/g, "_")}`),
    projectID: ProjectV2.ID.global,
    title: scenario.id,
    model: {
      providerID: ProviderV2.ID.make(scenario.providerID),
      id: ModelV2.ID.make(scenario.modelID),
    },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
    location,
  })
}

function delay(value: Delay) {
  if (value === "yield") return Effect.yieldNow
  if (value === "1ms") return Effect.sleep("1 millis")
  if (value === "10ms") return Effect.sleep("10 millis")
  return Effect.void
}
