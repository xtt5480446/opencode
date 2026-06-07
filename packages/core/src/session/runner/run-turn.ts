export * as RunTurn from "./run-turn"

/**
 * Drives one logical provider turn to settlement.
 *
 * A logical turn may rebuild its immutable preparation when concurrent Session,
 * agent, model, or Context Epoch changes make a prepared request stale. Each
 * prepared attempt invokes `llm.stream` at most once. A pre-output context
 * overflow may compact and rebuild once; later rebuilds do not restore that
 * recovery budget.
 */

import {
  LLM,
  LLMClient,
  LLMError,
  LLMEvent,
  SystemPart,
  isContextOverflowFailure,
  type ProviderErrorEvent,
} from "@opencode-ai/llm"
import { Cause, DateTime, Effect, FiberSet, Option, Schema, Semaphore, Stream } from "effect"
import { AgentV2 } from "../../agent"
import { Config } from "../../config"
import { Database } from "../../database/database"
import { EventV2 } from "../../event"
import { Location } from "../../location"
import { ModelV2 } from "../../model"
import { ProviderV2 } from "../../provider"
import { QuestionV2 } from "../../question"
import { SkillGuidance } from "../../skill/guidance"
import { SystemContext } from "../../system-context/index"
import { SystemContextRegistry } from "../../system-context/registry"
import { ToolOutputStore } from "../../tool-output-store"
import { ToolRegistry } from "../../tool/registry"
import { SessionCompaction } from "../compaction"
import { SessionContextEpoch } from "../context-epoch"
import { SessionEvent } from "../event"
import { SessionHistory } from "../history"
import { SessionInput } from "../input"
import { SessionSchema } from "../schema"
import { SessionStore } from "../store"
import type { RunError } from "./index"
import { SessionRunnerModel } from "./model"
import { createLLMEventPublisher } from "./publish-llm-event"
import { toLLMMessages } from "./to-llm-message"

export type Run = (
  sessionID: SessionSchema.ID,
  promotion: SessionInput.Delivery | undefined,
) => Effect.Effect<boolean, RunError>

const TurnTransition = Schema.TaggedUnion({
  RebuildPreparedTurn: { promotion: SessionInput.Delivery.pipe(Schema.optional) },
  ContinueAfterOverflowCompaction: {},
})

export const make = Effect.gen(function* () {
  const events = yield* EventV2.Service
  const llm = yield* LLMClient.Service
  const agents = yield* AgentV2.Service
  const tools = yield* ToolRegistry.Service
  const models = yield* SessionRunnerModel.Service
  const store = yield* SessionStore.Service
  const location = yield* Location.Service
  const systemContext = yield* SystemContextRegistry.Service
  const skillGuidance = yield* SkillGuidance.Service
  const config = yield* Config.Service
  const db = (yield* Database.Service).db
  const compaction = SessionCompaction.make({ events, llm, config: yield* config.entries() })

  const getSession = Effect.fn("SessionRunner.getSession")(function* (sessionID: SessionSchema.ID) {
    const session = yield* store.get(sessionID)
    if (!session) return yield* Effect.die(`Session not found: ${sessionID}`)
    return session
  })
  const awaitToolFibers = (fibers: FiberSet.FiberSet<void, ToolOutputStore.Error>) =>
    Effect.raceFirst(FiberSet.join(fibers), FiberSet.awaitEmpty(fibers))
  const isQuestionRejected = (cause: Cause.Cause<unknown>) =>
    cause.reasons.some((reason) => Cause.isDieReason(reason) && reason.defect instanceof QuestionV2.RejectedError)
  const rebuildPreparedTurn = (promotion?: SessionInput.Delivery) =>
    TurnTransition.cases.RebuildPreparedTurn.make({ promotion })
  const continueAfterOverflowCompaction = TurnTransition.cases.ContinueAfterOverflowCompaction.make({})
  const retryAgentMismatch = (promotion: SessionInput.Delivery | undefined) =>
    Effect.catchDefect((defect) =>
      defect instanceof SessionContextEpoch.AgentMismatch
        ? Effect.fail(rebuildPreparedTurn(promotion))
        : Effect.die(defect),
    )
  const sameModel = Schema.toEquivalence(Schema.UndefinedOr(ModelV2.Ref))
  const loadSystemContext = (agent: AgentV2.Selection) =>
    Effect.all([systemContext.load(), skillGuidance.load(agent)], { concurrency: "unbounded" }).pipe(
      Effect.map(SystemContext.combine),
    )

  /**
   * Promotes admitted input and builds one coherent immutable request snapshot.
   *
   * Rebuild transitions before promotion preserve the requested delivery;
   * transitions after promotion clear it so queued input cannot be promoted twice.
   */
  const prepareTurn = Effect.fn("SessionRunner.prepareTurn")(function* (
    sessionID: SessionSchema.ID,
    promotion: SessionInput.Delivery | undefined,
  ) {
    const session = yield* getSession(sessionID)
    if (session.location.directory !== location.directory || session.location.workspaceID !== location.workspaceID)
      return yield* Effect.interrupt
    const agent = yield* agents.select(session.agent)
    const initialized = yield* SessionContextEpoch.initialize(
      db,
      loadSystemContext(agent),
      session.id,
      session.location,
      agent.id,
    ).pipe(retryAgentMismatch(promotion))
    if (promotion) {
      const cutoff = yield* SessionInput.latestSeq(db, session.id)
      if (promotion === "steer") yield* SessionInput.promoteSteers(db, events, session.id, cutoff)
      if (promotion === "queue") {
        yield* SessionInput.promoteNextQueued(db, events, session.id)
        yield* SessionInput.promoteSteers(db, events, session.id, cutoff)
      }
    }
    const system =
      initialized ??
      (yield* SessionContextEpoch.prepare(
        db,
        events,
        loadSystemContext(agent),
        session.id,
        session.location,
        agent.id,
      ).pipe(retryAgentMismatch(undefined)))
    const current = yield* getSession(sessionID)
    if ((yield* agents.select(current.agent)).id !== agent.id || !sameModel(current.model, session.model))
      return yield* Effect.fail(rebuildPreparedTurn())
    const model = yield* models.resolve(session)
    const entries = yield* SessionHistory.entriesForRunner(db, session.id, system.baselineSeq)
    const context = entries.map((entry) => entry.message)
    const toolMaterialization = yield* tools.materialize(agent.info?.permissions)
    const promptCacheKey = /^ses_[0-9a-f]{64}$/.test(session.id) ? session.id.slice(4) : session.id
    const request = LLM.request({
      model,
      providerOptions: { openai: { promptCacheKey } },
      system: [agent.info?.system, system.baseline]
        .filter((part): part is string => part !== undefined && part.length > 0)
        .map(SystemPart.make),
      messages: toLLMMessages(context, model),
      tools: toolMaterialization.definitions,
    })
    if (yield* compaction.compactIfNeeded({ sessionID: session.id, entries, model, request }))
      return yield* Effect.fail(rebuildPreparedTurn())
    return { session, agent, model, entries, request, system, toolMaterialization }
  })

  type PreparedTurn = Effect.Success<ReturnType<typeof prepareTurn>>

  /**
   * Allocates the mutable state shared by provider consumption and settlement.
   * Publication is serialized because provider events and local tool results may
   * arrive concurrently but mutate one durable publisher state machine.
   */
  const makeRuntime = Effect.fnUntraced(function* (prepared: PreparedTurn) {
    const publisher = createLLMEventPublisher(events, {
      sessionID: prepared.session.id,
      agent: prepared.agent.id,
      model: {
        id: ModelV2.ID.make(prepared.model.id),
        providerID: ProviderV2.ID.make(prepared.model.provider),
        ...(prepared.session.model?.variant === undefined ? {} : { variant: prepared.session.model.variant }),
      },
    })
    const withPublication = Semaphore.makeUnsafe(1).withPermit
    return {
      publisher,
      withPublication,
      publish: (event: LLMEvent, outputPaths: ReadonlyArray<string> = []) =>
        withPublication(publisher.publish(event, outputPaths)),
      toolFibers: yield* FiberSet.make<void, ToolOutputStore.Error>(),
      needsContinuation: false,
      overflowFailure: undefined as ProviderErrorEvent | undefined,
    }
  })

  type TurnRuntime = Effect.Success<ReturnType<typeof makeRuntime>>

  /**
   * Consumes exactly one provider stream.
   *
   * Every event is durably published before a local tool starts. Tool settlement
   * is registered with the turn FiberSet before interruption can resume. A
   * recoverable pre-output overflow is withheld until the settlement phase.
   */
  const consumeProvider = (prepared: PreparedTurn, runtime: TurnRuntime) =>
    llm.stream(prepared.request).pipe(
      Stream.runForEach((event) =>
        Effect.gen(function* () {
          if (runtime.overflowFailure || runtime.publisher.hasProviderError()) return
          if (
            LLMEvent.is.providerError(event) &&
            isContextOverflowFailure(event) &&
            !runtime.publisher.hasAssistantStarted()
          ) {
            runtime.overflowFailure = event
            return
          }
          yield* runtime.publish(event)
          if (event.type !== "tool-call" || event.providerExecuted) return
          runtime.needsContinuation = true
          const assistantMessageID = yield* runtime.publisher.assistantMessageID(event.id)
          yield* Effect.uninterruptibleMask((restore) =>
            restore(
              prepared.toolMaterialization.settle({
                sessionID: prepared.session.id,
                agent: prepared.agent.id,
                assistantMessageID,
                call: event,
              }),
            ).pipe(
              Effect.flatMap((settlement) =>
                runtime.publish(
                  LLMEvent.toolResult({
                    id: event.id,
                    name: event.name,
                    result: settlement.result,
                    output: settlement.output,
                  }),
                  settlement.outputPaths ?? [],
                ),
              ),
            ),
          ).pipe(FiberSet.run(runtime.toolFibers))
        }),
      ),
      Effect.ensuring(runtime.withPublication(runtime.publisher.flush())),
    )

  /**
   * Runs one prepared provider attempt and settles every local tool it starts.
   *
   * The interruption mask keeps the handoff from stream completion to tool
   * settlement atomic, while provider consumption and tool work remain interruptible.
   */
  const runAttempt = Effect.fn("SessionRunner.runTurn")(function* (
    sessionID: SessionSchema.ID,
    promotion: SessionInput.Delivery | undefined,
    recoverOverflow?: typeof compaction.compactAfterOverflow,
  ) {
    const prepared = yield* prepareTurn(sessionID, promotion)
    const runtime = yield* makeRuntime(prepared)
    if (!(yield* SessionContextEpoch.current(db, prepared.session.id, prepared.agent.id, prepared.system.revision)))
      return yield* Effect.fail(rebuildPreparedTurn())

    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const stream = yield* restore(consumeProvider(prepared, runtime)).pipe(Effect.exit)
        const failure =
          stream._tag === "Failure" ? Option.getOrUndefined(Cause.findErrorOption(stream.cause)) : undefined
        if (
          recoverOverflow &&
          !runtime.publisher.hasAssistantStarted() &&
          isContextOverflowFailure(runtime.overflowFailure ?? failure) &&
          (yield* restore(
            recoverOverflow({
              sessionID: prepared.session.id,
              entries: prepared.entries,
              model: prepared.model,
              request: prepared.request,
            }),
          ))
        )
          return yield* Effect.fail(continueAfterOverflowCompaction)
        if (runtime.overflowFailure) yield* runtime.publish(runtime.overflowFailure)
        const llmFailure = failure instanceof LLMError ? failure : undefined
        if (llmFailure && !runtime.publisher.hasProviderError()) {
          yield* runtime.withPublication(
            runtime.publisher.failUnsettledTools("Provider did not return a tool result", true),
          )
          yield* runtime.withPublication(
            events.publish(SessionEvent.Step.Failed, {
              sessionID: prepared.session.id,
              timestamp: yield* DateTime.now,
              assistantMessageID: yield* runtime.publisher.startAssistant(),
              error: { type: "unknown", message: llmFailure.reason.message },
            }),
          )
        }
        if (stream._tag === "Failure" && Cause.hasInterrupts(stream.cause)) yield* FiberSet.clear(runtime.toolFibers)
        const settled = yield* restore(awaitToolFibers(runtime.toolFibers)).pipe(Effect.exit)
        if (settled._tag === "Failure" && isQuestionRejected(settled.cause)) {
          yield* FiberSet.clear(runtime.toolFibers)
          yield* runtime.withPublication(runtime.publisher.failUnsettledTools("Tool execution interrupted"))
          return yield* Effect.interrupt
        }
        if (
          (stream._tag === "Failure" && Cause.hasInterrupts(stream.cause)) ||
          (settled._tag === "Failure" && Cause.hasInterrupts(settled.cause))
        ) {
          yield* FiberSet.clear(runtime.toolFibers)
          yield* runtime.withPublication(runtime.publisher.failUnsettledTools("Tool execution interrupted"))
        }
        if (settled._tag === "Failure" && !Cause.hasInterrupts(settled.cause)) {
          const failure = Cause.squash(settled.cause)
          const message = failure instanceof Error ? failure.message : String(failure)
          yield* runtime.withPublication(runtime.publisher.failUnsettledTools(`Tool execution failed: ${message}`))
        }
        if (runtime.publisher.hasProviderError())
          yield* runtime.withPublication(runtime.publisher.failUnsettledTools("Tool execution interrupted"))
        if (stream._tag === "Success" && !runtime.publisher.hasProviderError())
          yield* runtime.withPublication(
            runtime.publisher.failUnsettledTools("Provider did not return a tool result", true),
          )
        if (stream._tag === "Failure") return yield* Effect.failCause(stream.cause)
        if (settled._tag === "Failure") return yield* Effect.failCause(settled.cause)
        return !runtime.publisher.hasProviderError() && runtime.needsContinuation
      }),
    )
  }, Effect.scoped)

  /** Rebuilds stale attempts while preserving the single overflow-recovery budget. */
  const runState = Effect.fnUntraced(function* (
    sessionID: SessionSchema.ID,
    promotion: SessionInput.Delivery | undefined,
    canRecoverOverflow: boolean,
  ): Effect.fn.Return<boolean, RunError> {
    return yield* runAttempt(
      sessionID,
      promotion,
      canRecoverOverflow ? compaction.compactAfterOverflow : undefined,
    ).pipe(
      Effect.catchTags({
        ContinueAfterOverflowCompaction: Effect.fnUntraced(function* () {
          yield* Effect.yieldNow
          return yield* runState(sessionID, undefined, false)
        }),
        RebuildPreparedTurn: Effect.fnUntraced(function* (transition) {
          yield* Effect.yieldNow
          return yield* runState(sessionID, transition.promotion, canRecoverOverflow)
        }),
      }),
    )
  })

  const run: Run = (sessionID, promotion) => runState(sessionID, promotion, true)

  return run
})
