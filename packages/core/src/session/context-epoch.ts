export * as SessionContextEpoch from "./context-epoch"

import { and, eq, isNull, lt, or, sql } from "drizzle-orm"
import { DateTime, Effect, Schema } from "effect"
import type { Database } from "../database/database"
import { EventV2 } from "../event"
import { SessionSystemContext } from "../session-system-context"
import { SystemContext } from "../system-context"
import { SessionEvent } from "./event"
import { SessionMessageID } from "./message-id"
import { SessionSchema } from "./schema"
import { SessionContextEpochTable } from "./sql"

type DatabaseService = Database.Interface["db"]

export const prepare = Effect.fn("SessionContextEpoch.prepare")(function* (
  db: DatabaseService,
  events: EventV2.Interface,
  context: SessionSystemContext.Interface,
  sessionID: SessionSchema.ID,
) {
  const [value, stored] = yield* Effect.all([context.load(), find(db, sessionID)], { concurrency: "unbounded" })
  if (!stored) {
    const generation = yield* SystemContext.initialize(value)
    const baselineSeq = yield* initialize(db, events, sessionID, generation)
    return { baseline: generation.baseline, baselineSeq }
  }

  const snapshot = yield* Schema.decodeUnknownEffect(SystemContext.Snapshot)(stored.snapshot).pipe(Effect.orDie)
  const result =
    stored.replacement_seq === null ? yield* SystemContext.reconcile(value, snapshot) : yield* SystemContext.replace(value, snapshot)
  if (result._tag === "Unchanged" || result._tag === "ReplacementBlocked")
    return { baseline: stored.baseline, baselineSeq: stored.baseline_seq }
  if (result._tag === "Replaced") {
    const replacementSeq = stored.replacement_seq ?? (yield* events.sequence(sessionID))
    yield* replace(db, sessionID, stored.revision, replacementSeq, result.generation)
    return { baseline: result.generation.baseline, baselineSeq: replacementSeq }
  }

  yield* events.publish(
    SessionEvent.ContextUpdated,
    { sessionID, messageID: SessionMessageID.ID.create(), timestamp: yield* DateTime.now, text: result.text },
    { commit: () => advance(db, sessionID, stored.revision, result.snapshot).pipe(Effect.orDie) },
  )
  return { baseline: stored.baseline, baselineSeq: stored.baseline_seq }
})

const find = Effect.fn("SessionContextEpoch.find")(function* (db: DatabaseService, sessionID: SessionSchema.ID) {
  return yield* db
    .select()
    .from(SessionContextEpochTable)
    .where(eq(SessionContextEpochTable.session_id, sessionID))
    .get()
    .pipe(Effect.orDie)
})

export const requestReplacement = Effect.fn("SessionContextEpoch.requestReplacement")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  seq: number,
) {
  return yield* db
    .update(SessionContextEpochTable)
    .set({ replacement_seq: seq, revision: sql`${SessionContextEpochTable.revision} + 1` })
    .where(
      and(
        eq(SessionContextEpochTable.session_id, sessionID),
        lt(SessionContextEpochTable.baseline_seq, seq),
        or(isNull(SessionContextEpochTable.replacement_seq), lt(SessionContextEpochTable.replacement_seq, seq)),
      ),
    )
    .run()
    .pipe(Effect.orDie)
})

const initialize = Effect.fnUntraced(function* (
  db: DatabaseService,
  events: EventV2.Interface,
  sessionID: SessionSchema.ID,
  generation: SystemContext.Generation,
) {
  return yield* db
    .transaction(
      () =>
        Effect.gen(function* () {
          const baselineSeq = yield* events.sequence(sessionID)
          yield* db
            .insert(SessionContextEpochTable)
            .values({
              session_id: sessionID,
              baseline: generation.baseline,
              snapshot: generation.snapshot,
              baseline_seq: baselineSeq,
              revision: 0,
            })
            .run()
            .pipe(Effect.orDie)
          return baselineSeq
        }),
      { behavior: "immediate" },
    )
    .pipe(Effect.orDie)
})

const replace = Effect.fnUntraced(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  expectedRevision: number,
  baselineSeq: number,
  generation: SystemContext.Generation,
) {
  yield* db
    .transaction(
      () =>
        Effect.gen(function* () {
          const updated = yield* db
            .update(SessionContextEpochTable)
            .set({
              baseline: generation.baseline,
              snapshot: generation.snapshot,
              baseline_seq: baselineSeq,
              replacement_seq: null,
              revision: expectedRevision + 1,
            })
            .where(
              and(
                eq(SessionContextEpochTable.session_id, sessionID),
                eq(SessionContextEpochTable.revision, expectedRevision),
              ),
            )
            .returning({ revision: SessionContextEpochTable.revision })
            .get()
            .pipe(Effect.orDie)
          if (!updated) return yield* Effect.die("Session context epoch revision mismatch")
        }),
      { behavior: "immediate" },
    )
    .pipe(Effect.orDie)
})

const advance = Effect.fnUntraced(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  expectedRevision: number,
  snapshot: SystemContext.Snapshot,
) {
  const updated = yield* db
    .update(SessionContextEpochTable)
    .set({ snapshot, revision: expectedRevision + 1 })
    .where(
      and(
        eq(SessionContextEpochTable.session_id, sessionID),
        eq(SessionContextEpochTable.revision, expectedRevision),
        isNull(SessionContextEpochTable.replacement_seq),
      ),
    )
    .returning({ revision: SessionContextEpochTable.revision })
    .get()
    .pipe(Effect.orDie)
  if (!updated) return yield* Effect.die("Session context epoch revision mismatch")
})
