import fs from "node:fs/promises"
import path from "node:path"
import { runScenario } from "./provider-catalog-race-harness"

const out = path.resolve(process.env.OPENCODE_PROBE_OUT ?? "/tmp/opencode-provider-catalog-race-repro")
await fs.rm(out, { recursive: true, force: true })
await fs.mkdir(out, { recursive: true })

const result = await runScenario(
  {
    id: "cold-immediate",
    delay: "none",
    providerID: "console-openai",
    modelID: "gpt-5.6-sol",
    configuredDefault: true,
    apiKey: true,
    disabled: false,
    repeats: 2,
  },
  path.join(out, "state"),
)

await fs.writeFile(path.join(out, "result.json"), JSON.stringify(result, undefined, 2) + "\n")
for (const snapshot of result.snapshots) {
  console.log(
    JSON.stringify({
      attempt: snapshot.attempt,
      providers: snapshot.providers,
      models: snapshot.models,
      resolved: snapshot.resolved,
      error: snapshot.error,
    }),
  )
}
console.log(`${result.reproduced ? "REPRODUCED" : "NOT REPRODUCED"}: cold location provider catalog startup race`)
console.log(`Artifacts: ${out}`)
process.exitCode = result.reproduced ? 1 : 0
