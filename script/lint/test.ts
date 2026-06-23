import path from "path"
import { mkdtemp, rm } from "fs/promises"

const cases = [
  {
    name: "schema field",
    errors: 0,
    source: `import { Schema } from "effect"
class Example extends Schema.TaggedErrorClass<Example>()("Example", { message: Schema.String }) {}`,
  },
  {
    name: "getter",
    errors: 0,
    source: `import { Schema } from "effect"
class Example extends Schema.TaggedErrorClass<Example>()("Example", {}) {
  override get message() { return "Example failed" }
}`,
  },
  {
    name: "initialized property",
    errors: 0,
    source: `import { Schema } from "effect"
const Example = class extends Schema.TaggedErrorClass<Example>()("Example", {}) {
  override message = "Example failed"
}`,
  },
  {
    name: "namespace import",
    errors: 0,
    source: `import * as Schema from "effect/Schema"
export namespace Example { export class Error extends Schema.TaggedErrorClass<Error>()("Example", { message: Schema.String }) {} }`,
  },
  {
    name: "spread fields",
    errors: 0,
    source: `import { Schema } from "effect"
const fields = { message: Schema.String }
class Example extends Schema.TaggedErrorClass<Example>()("Example", { ...fields }) {}`,
  },
  {
    name: "computed fields",
    errors: 0,
    source: `import { Schema } from "effect"
const key = "message"
class Example extends Schema.TaggedErrorClass<Example>()("Example", { [key]: Schema.String }) {}`,
  },
  {
    name: "unrelated Schema binding",
    errors: 0,
    source: `const Schema = getSchema()
class Example extends Schema.TaggedErrorClass()("Example", {}) {}`,
  },
  {
    name: "missing message",
    errors: 1,
    source: `import { Schema } from "effect"
class Example extends Schema.TaggedErrorClass<Example>()("Example", { cause: Schema.Defect }) {}`,
  },
  {
    name: "static message",
    errors: 1,
    source: `import { Schema } from "effect"
class Example extends Schema.TaggedErrorClass<Example>()("Example", {}) { static message = "Example failed" }`,
  },
  {
    name: "uninitialized property",
    errors: 1,
    source: `import { Schema } from "effect"
class Example extends Schema.TaggedErrorClass<Example>()("Example", {}) { declare message: string }`,
  },
  {
    name: "documented disable",
    errors: 0,
    source: `import { Schema } from "effect"
// oxlint-disable-next-line opencode/tagged-error-message -- internal control-flow sentinel
class Example extends Schema.TaggedErrorClass<Example>()("Example", {}) {}`,
  },
]

const directory = await mkdtemp(path.join(import.meta.dir, "../../.lint-tmp-"))
const config = path.join(directory, ".oxlintrc.json")

try {
  await Bun.write(
    config,
    JSON.stringify({
      jsPlugins: [path.join(import.meta.dir, "opencode.mjs")],
      rules: { "opencode/tagged-error-message": "error" },
    }),
  )
  for (const [index, fixture] of cases.entries()) {
    const file = path.join(directory, `${index}.ts`)
    await Bun.write(file, fixture.source)
    const result = Bun.spawnSync([
      path.join(import.meta.dir, "../../node_modules/.bin/oxlint"),
      "--config",
      config,
      "--format",
      "json",
      file,
    ])
    if (!result.stdout.length) throw new Error(`${fixture.name}: ${result.stderr.toString()}`)
    const diagnostics: unknown = JSON.parse(result.stdout.toString())
    if (!hasDiagnostics(diagnostics)) throw new Error(`${fixture.name}: invalid Oxlint output`)
    const errors = diagnostics.diagnostics.filter(
      (item) => typeof item === "object" && item !== null && "code" in item && item.code === "opencode(tagged-error-message)",
    ).length
    if (errors !== fixture.errors)
      throw new Error(
        `${fixture.name}: expected ${fixture.errors} errors, received ${errors}\n${result.stdout.toString()}`,
      )
  }
} finally {
  await rm(directory, { recursive: true, force: true })
}

console.log(`Validated ${cases.length} tagged error lint fixtures`)

function hasDiagnostics(value: unknown): value is { diagnostics: unknown[] } {
  return typeof value === "object" && value !== null && "diagnostics" in value && Array.isArray(value.diagnostics)
}
