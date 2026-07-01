export * as Tool from "./tool.js"

import { ToolDefinition, ToolFailure, ToolOutput, type ToolCall } from "@opencode-ai/llm"
import { Agent } from "@opencode-ai/schema/agent"
import { Session } from "@opencode-ai/schema/session"
import { SessionMessage } from "@opencode-ai/schema/session-message"
import { Effect, JsonSchema, Schema, type Scope } from "effect"

export interface Context<Output = unknown> {
  readonly sessionID: Session.ID
  readonly agent: Agent.ID
  readonly assistantMessageID: SessionMessage.ID
  readonly toolCallID: string
  readonly progress: (state: State<Output>) => Effect.Effect<void>
}

export type SchemaType<A> = Schema.Codec<A, any>

declare const TypeId: unique symbol

export interface Definition<Input extends SchemaType<any>, Output extends SchemaType<any>> {
  readonly [TypeId]: {
    readonly _Input: Input
    readonly _Output: Output
  }
}

export type AnyTool = Definition<any, any>
export const Failure = ToolFailure
export type Failure = ToolFailure

const ResultTypeId = Symbol("@opencode-ai/plugin/Tool.Result")

export interface State<Output> {
  readonly output: Output
  readonly content?: ReadonlyArray<Content>
}

export interface Result<Output> extends State<Output> {
  readonly [ResultTypeId]: true
}

class ResultValue<Output> implements Result<Output> {
  readonly output: Output
  readonly content?: ReadonlyArray<Content>

  get [ResultTypeId]() {
    return true as const
  }

  constructor(state: State<Output>) {
    this.output = state.output
    this.content = state.content
  }
}

export const result = <Output>(state: State<Output>): Result<Output> => Object.freeze(new ResultValue(state))

export class RegistrationError extends Schema.TaggedErrorClass<RegistrationError>()("Tool.RegistrationError", {
  name: Schema.String,
  message: Schema.String,
}) {}

export type Content =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "file"; readonly data: string; readonly mime: string; readonly name?: string }

type Config<Input extends SchemaType<any>, Output extends SchemaType<any>> = {
  readonly description: string
  readonly input: Input
  readonly output: Output
  readonly execute: (
    input: Schema.Schema.Type<Input>,
    context: Context<Schema.Schema.Type<Output>>,
  ) => Effect.Effect<Schema.Schema.Type<Output> | Result<Schema.Schema.Type<Output>>, ToolFailure>
}

/**
 * Config for a tool whose input shape is a raw JSON Schema not known at compile
 * time (MCP servers, plugin manifests). Input is passed through as `unknown`;
 * Return `Tool.result(...)` when the output needs explicit model content.
 */
type DynamicConfig = {
  readonly description: string
  readonly jsonSchema: JsonSchema.JsonSchema
  readonly outputSchema?: JsonSchema.JsonSchema
  readonly execute: (input: unknown, context: Context) => Effect.Effect<unknown, ToolFailure>
}

export interface RuntimeContext extends Omit<Context, "progress"> {
  readonly progress?: (output: ToolOutput) => Effect.Effect<void, unknown>
}

type Runtime = {
  readonly permission?: string
  readonly definition: (name: string) => ToolDefinition
  readonly settle: (call: ToolCall, context: RuntimeContext) => Effect.Effect<ToolOutput, ToolFailure>
}

const runtimes = new WeakMap<AnyTool, Runtime>()

export function make<Input extends SchemaType<any>, Output extends SchemaType<any>>(
  config: Config<Input, Output>,
): Definition<Input, Output>
export function make(config: DynamicConfig): AnyTool
export function make(config: Config<any, any> | DynamicConfig): AnyTool {
  if ("jsonSchema" in config) return makeDynamic(config)
  return makeTyped(config)
}

function makeTyped<Input extends SchemaType<any>, Output extends SchemaType<any>>(
  config: Config<Input, Output>,
): Definition<Input, Output> {
  const tool = Object.freeze({}) as Definition<Input, Output>
  const definitions = new Map<string, ToolDefinition>()

  const projectState = (state: State<Schema.Schema.Type<Output>>): Effect.Effect<ToolOutput, ToolFailure> =>
    Schema.encodeEffect(config.output)(state.output).pipe(
      Effect.map((output) => ToolOutput.make(output, contentOf(output, state.content))),
      Effect.mapError(
        (error) =>
          new ToolFailure({
            message: `Tool returned an invalid value for its output schema: ${error.message}`,
          }),
      ),
    )

  const project = (value: Schema.Schema.Type<Output> | Result<Schema.Schema.Type<Output>>) =>
    projectState(stateOf(value))

  runtimes.set(tool, {
    definition: (name) => {
      const cached = definitions.get(name)
      if (cached) return cached
      const definition = new ToolDefinition({
        name,
        description: config.description,
        inputSchema: toJsonSchema(config.input),
        outputSchema: toJsonSchema(config.output),
      })
      definitions.set(name, definition)
      return definition
    },
    settle: (call, context) =>
      Schema.decodeUnknownEffect(config.input)(call.input).pipe(
        Effect.mapError((error) => new ToolFailure({ message: `Invalid tool input: ${error.message}` })),
        Effect.flatMap((input) =>
          config
            .execute(input, {
              ...context,
              progress: (state) =>
                context.progress
                  ? projectState(state).pipe(Effect.flatMap(context.progress), Effect.ignore)
                  : Effect.void,
            })
            .pipe(Effect.flatMap(project)),
        ),
      ),
  })
  return tool
}

function makeDynamic(config: DynamicConfig): AnyTool {
  const tool = Object.freeze({}) as AnyTool
  const definitions = new Map<string, ToolDefinition>()
  const projectState = (state: State<unknown>) => ToolOutput.make(state.output, contentOf(state.output, state.content))
  const project = (value: unknown) => projectState(stateOf(value))
  runtimes.set(tool, {
    definition: (name) => {
      const cached = definitions.get(name)
      if (cached) return cached
      const definition = new ToolDefinition({
        name,
        description: config.description,
        inputSchema: config.jsonSchema,
        outputSchema: config.outputSchema,
      })
      definitions.set(name, definition)
      return definition
    },
    settle: (call, context) =>
      config
        .execute(call.input, {
          ...context,
          progress: (state) => context.progress?.(projectState(state)).pipe(Effect.ignore) ?? Effect.void,
        })
        .pipe(Effect.map(project)),
  })
  return tool
}

function stateOf<Output>(value: Output | Result<Output>): State<Output> {
  if (isResult(value)) return value
  return { output: value }
}

function isResult(value: unknown): value is Result<unknown> {
  return typeof value === "object" && value !== null && ResultTypeId in value
}

function contentOf(output: unknown, content: ReadonlyArray<Content> | undefined) {
  return content?.map(toModelContent) ?? (typeof output === "string" ? [{ type: "text" as const, text: output }] : [])
}

function toModelContent(part: Content) {
  if (part.type === "text") return { type: "text" as const, text: part.text }
  return { type: "file" as const, uri: `data:${part.mime};base64,${part.data}`, mime: part.mime, name: part.name }
}

export const validateName = (name: string) =>
  /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(name)
    ? Effect.void
    : Effect.fail(new RegistrationError({ name, message: `Invalid tool name: ${name}` }))

export const registrationEntries = (tools: Readonly<Record<string, AnyTool>>) =>
  Object.entries(tools).map(([name, tool]) => [name.replace(/[^a-zA-Z0-9_-]/g, "_"), tool] as const)

export const withPermission = <Input extends SchemaType<any>, Output extends SchemaType<any>>(
  tool: Definition<Input, Output>,
  permission: string,
) => {
  const decorated = Object.freeze({}) as Definition<Input, Output>
  runtimes.set(decorated, { ...runtimeOf(tool), permission })
  return decorated
}

export const permission = (tool: AnyTool, name: string) => runtimeOf(tool).permission ?? name
export const definition = (name: string, tool: AnyTool) => runtimeOf(tool).definition(name)
export const settle = (tool: AnyTool, call: ToolCall, context: RuntimeContext) => runtimeOf(tool).settle(call, context)

function runtimeOf(tool: AnyTool) {
  const runtime = runtimes.get(tool)
  if (!runtime) throw new TypeError("Invalid Tool value")
  return runtime
}

function toJsonSchema(schema: Schema.Top): JsonSchema.JsonSchema {
  const document = Schema.toJsonSchemaDocument(schema)
  if (Object.keys(document.definitions).length === 0) return document.schema
  return { ...document.schema, $defs: document.definitions }
}

export interface ToolDomain {
  readonly register: (tools: Readonly<Record<string, AnyTool>>) => Effect.Effect<void, RegistrationError, Scope.Scope>
}
