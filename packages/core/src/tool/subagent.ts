export * as SubagentTool from "./subagent"

import { ToolFailure } from "@opencode-ai/llm"
import type { PluginContext } from "@opencode-ai/plugin/v2/effect"
import { Effect, Schema, Scope } from "effect"
import { AgentV2 } from "../agent"
import { PluginRuntime } from "../plugin/runtime"
import { SessionSchema } from "../session/schema"
import { Tool } from "./tool"

export const name = "subagent"

const NO_TEXT = "Subagent completed without a text response."
const BACKGROUND_STARTED =
  "The subagent is working in the background. You will be notified automatically when it finishes. DO NOT sleep, poll, or proactively check on its progress."

const renderOutput = (input: {
  sessionID: SessionSchema.ID | string
  state: "completed" | "running" | "error" | "cancelled"
  description?: string
  text: string
}) =>
  [
    `<subagent id="${input.sessionID}" state="${input.state}"${input.description ? ` description="${input.description}"` : ""}>`,
    input.text,
    "</subagent>",
  ].join("\n")

export const Input = Schema.Struct({
  agent: Schema.String.annotate({ description: "The configured agent to run as the subagent" }),
  description: Schema.String.annotate({ description: "A short description of the subagent's task" }),
  prompt: Schema.String.annotate({ description: "The task for the subagent to perform" }),
  subagent_id: SessionSchema.ID.pipe(Schema.optional).annotate({
    description:
      "Set this only to continue a previous subagent session. Pass the id from an earlier subagent result and the prompt will continue that same subagent session instead of creating a new one.",
  }),
  background: Schema.Boolean.pipe(Schema.optional).annotate({
    description:
      "Run the subagent in the background and return immediately. You will be notified when it completes. DO NOT poll its progress.",
  }),
})

export const Output = Schema.Struct({
  sessionID: SessionSchema.ID,
  status: Schema.Literals(["completed", "running"]),
  output: Schema.String,
})

export const description = [
  "Spawn a subagent: a child session running a configured agent with fresh context.",
  "Each new subagent invocation starts with fresh context unless subagent_id is provided to continue the same subagent session.",
  "The result includes a subagent id. Reuse it as subagent_id only when you need to send more prompts to that same subagent.",
  "Foreground (default) runs the subagent to completion and returns its final response.",
  "Background mode (background=true) launches it asynchronously and returns immediately; you are notified when it finishes.",
  "Use background only for independent work that can run while you continue elsewhere.",
].join("\n")

export const Plugin = {
  id: "core-subagent-tool",
  effect: Effect.fn("SubagentTool.Plugin")(function* (ctx: PluginContext) {
    const runtime = yield* PluginRuntime.Service
    const agents = yield* AgentV2.Service
    const scope = yield* Scope.Scope

    // Concatenate the child's final completed assistant text. Distinguishes "completed with no
    // text" (generic string) from "failed" (the run effect fails, surfaced as a job error).
    const latestAssistantText = Effect.fn("SubagentTool.latestAssistantText")(function* (sessionID: SessionSchema.ID) {
      const messages = yield* runtime.session.messages({ sessionID, order: "desc", limit: 20 })
      const assistant = messages.find(
        (message) =>
          message.type === "assistant" && message.time.completed !== undefined && message.error === undefined,
      )
      if (assistant === undefined || assistant.type !== "assistant") return NO_TEXT
      const text = assistant.content
        .filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
        .map((part) => part.text)
        .join("")
      return text.length > 0 ? text : NO_TEXT
    })

    const injectCompletion = Effect.fn("SubagentTool.injectCompletion")(function* (
      parentID: SessionSchema.ID,
      childID: SessionSchema.ID,
      description: string,
      state: "completed" | "error" | "cancelled",
      text: string,
    ) {
      yield* runtime.session.synthetic({
        sessionID: parentID,
        text: renderOutput({ sessionID: childID, state, description, text }),
      })
    })

    const notifyWhenDone = Effect.fn("SubagentTool.notifyWhenDone")(function* (
      parentID: SessionSchema.ID,
      childID: SessionSchema.ID,
      description: string,
    ) {
      yield* runtime.job.wait({ id: childID }).pipe(
        Effect.flatMap((result) => {
          if (result.info?.status === "completed")
            return injectCompletion(parentID, childID, description, "completed", result.info.output ?? NO_TEXT)
          if (result.info?.status === "error")
            return injectCompletion(parentID, childID, description, "error", result.info.error ?? "Subagent failed")
          if (result.info?.status === "cancelled")
            return injectCompletion(parentID, childID, description, "cancelled", "Subagent cancelled")
          return Effect.void
        }),
        Effect.forkIn(scope, { startImmediately: true }),
      )
    })

    yield* ctx.tool
      .register({
        [name]: Tool.make({
          description,
          input: Input,
          output: Output,
          toModelOutput: ({ input, output }) => [
            {
              type: "text",
              text: renderOutput({
                sessionID: output.sessionID,
                state: output.status,
                description: input.description,
                text: output.output,
              }),
            },
          ],
          execute: (input, context) =>
            Effect.gen(function* () {
              const parent = yield* runtime.session
                .get(context.sessionID)
                .pipe(
                  Effect.mapError(() => new ToolFailure({ message: `Parent session not found: ${context.sessionID}` })),
                )
              const agent = yield* agents.resolve(input.agent)
              if (agent === undefined) return yield* new ToolFailure({ message: `Unknown agent: ${input.agent}` })
              if (agent.mode === "primary")
                return yield* new ToolFailure({ message: `Agent ${input.agent} cannot run as a subagent` })

              // Model selection is policy/config/session state, not an LLM-facing tool argument.
              const model = agent.model ?? parent.model
              const agentID = AgentV2.ID.make(input.agent)
              const child = input.subagent_id
                ? yield* runtime.session
                    .get(input.subagent_id)
                    .pipe(
                      Effect.mapError(() => new ToolFailure({ message: `Subagent not found: ${input.subagent_id}` })),
                    )
                : yield* runtime.session
                    .create({
                      parentID: context.sessionID,
                      title: input.description,
                      agent: agentID,
                      model,
                      // TODO(opencode kkdvxn): derive restricted subagent permissions from the parent
                      // session (V1 deriveSubagentSessionPermission). MVP uses the agent's own permissions.
                    })
                    .pipe(
                      Effect.mapError(
                        () => new ToolFailure({ message: `Parent session not found: ${context.sessionID}` }),
                      ),
                    )
              if (input.subagent_id && child.parentID !== context.sessionID)
                return yield* new ToolFailure({
                  message: `Subagent ${input.subagent_id} does not belong to this session`,
                })
              if (input.subagent_id && child.agent !== agentID)
                return yield* new ToolFailure({
                  message: `Subagent ${input.subagent_id} is not using agent ${input.agent}`,
                })

              const background = input.background === true

              const run = Effect.gen(function* () {
                // The child session owns its agent/model (set at create); prompt only admits input.
                yield* runtime.session.prompt({ sessionID: child.id, prompt: { text: input.prompt }, resume: false })
                yield* runtime.session.resume(child.id)
                return yield* latestAssistantText(child.id)
              }).pipe(Effect.onInterrupt(() => runtime.session.interrupt(child.id)))

              const info = yield* runtime.job.start({
                id: child.id,
                type: name,
                title: input.description,
                metadata: {},
                run,
              })

              if (background) {
                yield* runtime.job.background(info.id)
                yield* notifyWhenDone(context.sessionID, child.id, input.description)
                return { sessionID: child.id, status: "running" as const, output: BACKGROUND_STARTED }
              }

              const result = yield* runtime.job.block({ id: child.id, sessionID: context.sessionID }).pipe(
                Effect.onInterrupt(() =>
                  Effect.all([runtime.session.interrupt(child.id), runtime.job.cancel(child.id)], {
                    discard: true,
                  }),
                ),
              )
              if (result?.type === "backgrounded") {
                yield* notifyWhenDone(context.sessionID, child.id, input.description)
                return { sessionID: child.id, status: "running" as const, output: BACKGROUND_STARTED }
              }
              if (result?.info.status === "error")
                return yield* new ToolFailure({ message: result.info.error ?? "Subagent failed" })
              if (result?.info.status === "cancelled") return yield* new ToolFailure({ message: "Subagent cancelled" })
              return { sessionID: child.id, status: "completed" as const, output: result?.info.output ?? NO_TEXT }
            }),
        }),
      })
      .pipe(Effect.orDie)
  }),
}
