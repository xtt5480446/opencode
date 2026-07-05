import fs from "node:fs/promises"
import path from "node:path"
import { runScenario, type Delay, type Result, type Scenario } from "./provider-catalog-race-harness"

const count = numberArg("--count", 64)
const seed = numberArg("--seed", 42000)
const out = path.resolve(stringArg("--out", "/tmp/opencode-provider-catalog-race-campaign"))
await fs.rm(out, { recursive: true, force: true })
await fs.mkdir(out, { recursive: true })

const results: Result[] = []
for (let index = 0; index < count; index++) {
  const scenario = generate(seed + index, index)
  const directory = path.join(out, `case-${String(index + 1).padStart(3, "0")}-${seed + index}`)
  const result = await runScenario(scenario, path.join(directory, "state"))
  await fs.mkdir(directory, { recursive: true })
  await fs.writeFile(path.join(directory, "scenario.json"), JSON.stringify(scenario, undefined, 2) + "\n")
  await fs.writeFile(path.join(directory, "result.json"), JSON.stringify(result, undefined, 2) + "\n")
  results.push(result)
  console.log(`[${index + 1}/${count}] ${scenario.id}: ${result.reproduced ? "RACE" : "ok"}`)
}

const summary = {
  seed,
  count,
  reproduced: results.filter((item) => item.reproduced).length,
  firstAttemptFailures: results.filter((item) => item.snapshots[0]?.error).length,
  recoveredOnLaterAttempt: results.filter(
    (item) => item.snapshots[0]?.error && item.snapshots.slice(1).some((snapshot) => snapshot.resolved),
  ).length,
  byDelay: Object.fromEntries(
    (["none", "yield", "1ms", "10ms"] as Delay[]).map((delay) => [
      delay,
      {
        count: results.filter((item) => item.scenario.delay === delay).length,
        reproduced: results.filter((item) => item.scenario.delay === delay && item.reproduced).length,
      },
    ]),
  ),
}
await fs.writeFile(path.join(out, "summary.json"), JSON.stringify(summary, undefined, 2) + "\n")
console.log(JSON.stringify(summary, undefined, 2))
console.log(`Artifacts: ${out}`)
process.exitCode = summary.reproduced > 0 ? 1 : 0

function generate(value: number, index: number): Scenario {
  const random = rng(value)
  const delays: Delay[] = ["none", "yield", "1ms", "10ms"]
  return {
    id: `seed-${value}`,
    delay: delays[index % delays.length]!,
    providerID: `provider-${index % 8}`,
    modelID: `model-${Math.floor(random() * 8)}`,
    configuredDefault: random() < 0.75,
    apiKey: true,
    disabled: random() < 0.1,
    repeats: 3,
  }
}

function rng(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 0x1_0000_0000
  }
}

function stringArg(name: string, fallback: string) {
  const index = process.argv.indexOf(name)
  return index < 0 ? fallback : (process.argv[index + 1] ?? fallback)
}

function numberArg(name: string, fallback: number) {
  return Number(stringArg(name, String(fallback)))
}
