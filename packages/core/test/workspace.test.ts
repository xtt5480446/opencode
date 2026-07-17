import { describe, expect } from "bun:test"
import { Effect, Exit } from "effect"
import { adjust } from "effect/testing/TestClock"
import { eq } from "drizzle-orm"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { AppProcess } from "@opencode-ai/core/process"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { WorkspaceV2 } from "@opencode-ai/core/workspace"
import { WorkspaceTable } from "@opencode-ai/core/control-plane/workspace.sql"
import { Sandbox } from "@opencode-ai/core/workspace/sandbox"
import { WorkspaceEnvironment } from "@opencode-ai/core/workspace/environment"
import { testEffect } from "./lib/effect"

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Database.node, Sandbox.registryNode, WorkspaceV2.node, AppProcess.node])),
)

describe("WorkspaceV2", () => {
  it.effect("loads metadata without connecting and shares a scoped connection", () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const process = yield* AppProcess.Service
      const registry = yield* Sandbox.RegistryService
      const workspace = yield* WorkspaceV2.Service
      const id = WorkspaceV2.ID.make("wrk_hosted")
      const projectID = Project.ID.make("hosted-project")
      const directory = AbsolutePath.make("/workspace/repo")
      const lifecycle = { connected: 0, reconciled: 0, released: 0 }
      const unsupported = (operation: string) => Effect.fail(new WorkspaceEnvironment.Error({ operation }))
      const environment = WorkspaceEnvironment.Service.of({
        platform: "linux",
        directory,
        process,
        shell: {
          executable: "/bin/sh",
          args: (command) => ["-c", command],
          environmentOverrides: {},
          detached: false,
        },
        ripgrep: Effect.succeed("/usr/bin/rg"),
        files: {
          inspect: () => unsupported("inspect"),
          resolve: () => unsupported("resolve"),
          read: () => unsupported("read"),
          list: () => unsupported("list"),
          ensureDirectory: () => unsupported("ensureDirectory"),
          createExclusive: () => unsupported("createExclusive"),
          write: () => unsupported("write"),
          writeIfUnchanged: () => unsupported("writeIfUnchanged"),
          remove: () => unsupported("remove"),
        },
      })

      yield* db
        .insert(ProjectTable)
        .values({
          id: projectID,
          worktree: directory,
          sandboxes: [],
          time_created: 1,
          time_updated: 1,
        })
        .run()
      yield* db
        .insert(WorkspaceTable)
        .values({
          id,
          type: "fake",
          name: "Hosted",
          directory,
          extra: { kind: "sandbox", version: 1, binding: { sandbox: "one" } },
          project_id: projectID,
          time_used: 1,
        })
        .run()
      yield* registry.register({
        key: "fake",
        decode: Effect.succeed,
        connect: () =>
          Effect.acquireRelease(
            Effect.sync(() => {
              lifecycle.connected++
              return { binding: { sandbox: "live", retired: "one" }, environment }
            }),
            () => Effect.sync(() => lifecycle.released++),
          ),
        reconcile: () =>
          Effect.sync(() => {
            lifecycle.reconciled++
            return { sandbox: "live" }
          }),
      })

      expect(yield* workspace.get(id)).toEqual({
        id,
        name: "Hosted",
        directory,
        project: { id: projectID, directory },
      })
      expect(lifecycle.connected).toBe(0)

      const borrowed = yield* Effect.all([workspace.borrow(id), workspace.borrow(id)]).pipe(Effect.scoped)
      expect(borrowed[0]).toBe(environment)
      expect(borrowed[1]).toBe(environment)
      expect(lifecycle.connected).toBe(1)
      expect(lifecycle.reconciled).toBe(1)
      expect(lifecycle.released).toBe(0)
      const placement = yield* db.select().from(WorkspaceTable).where(eq(WorkspaceTable.id, id)).get()
      expect(placement?.extra).toEqual({
        kind: "sandbox",
        version: 1,
        binding: { sandbox: "live" },
      })

      yield* adjust("1 minute")
      yield* Effect.yieldNow
      expect(lifecycle.released).toBe(1)

      const invalidID = WorkspaceV2.ID.make("wrk_invalid")
      yield* db
        .insert(WorkspaceTable)
        .values({
          id: invalidID,
          type: "fake",
          name: "Legacy",
          directory,
          extra: { sandbox: "legacy-adapter-state" },
          project_id: projectID,
          time_used: 1,
        })
        .run()
      const invalid = yield* workspace.borrow(invalidID).pipe(Effect.scoped, Effect.flip)
      expect(invalid._tag).toBe("Workspace.InvalidError")
      expect(lifecycle.connected).toBe(1)

      const retryID = WorkspaceV2.ID.make("wrk_retry")
      const retry = { attempts: 0 }
      yield* db
        .insert(WorkspaceTable)
        .values({
          id: retryID,
          type: "flaky",
          name: "Retry",
          directory,
          extra: { kind: "sandbox", version: 1, binding: { sandbox: "retry" } },
          project_id: projectID,
          time_used: 1,
        })
        .run()
      yield* registry.register({
        key: "flaky",
        decode: Effect.succeed,
        connect: (binding) =>
          Effect.sync(() => ++retry.attempts).pipe(
            Effect.flatMap((attempt) =>
              attempt === 1 ? Effect.die("Transient provider defect") : Effect.succeed({ binding, environment }),
            ),
          ),
        reconcile: Effect.succeed,
      })

      expect(Exit.isFailure(yield* workspace.borrow(retryID).pipe(Effect.scoped, Effect.exit))).toBe(true)
      expect(yield* workspace.borrow(retryID).pipe(Effect.scoped)).toBe(environment)
      expect(retry.attempts).toBe(2)
    }),
  )
})
