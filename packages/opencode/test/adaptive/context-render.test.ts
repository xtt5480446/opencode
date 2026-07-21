import { describe, expect, test } from "bun:test"
import { Hash } from "@opencode-ai/core/util/hash"
import { Token } from "@opencode-ai/core/util/token"
import { AdaptiveEvent } from "@opencode-ai/schema/adaptive-event"
import { AdaptiveOperation } from "@opencode-ai/schema/adaptive-operation"
import { AdaptiveRoadmap } from "@opencode-ai/schema/adaptive-roadmap"
import { AdaptiveTask } from "@opencode-ai/schema/adaptive-task"
import { AdaptiveContextComponent } from "@/adaptive/context/component"
import { AdaptiveContextRender } from "@/adaptive/context/render"

const taskID = AdaptiveTask.ID.create()
const workerID = AdaptiveTask.AgentID.create()
const hash = (letter: string) => AdaptiveOperation.Hash.make(`sha256:${letter.repeat(64)}`)

const roadmap = new AdaptiveRoadmap.Info({
  taskID,
  revision: 3,
  requirement: new AdaptiveRoadmap.RequirementBaseline({
    objective: "Keep retry behavior consistent.",
    scope: ["worker", "timer"],
    constraints: ["no provider call"],
    acceptance: ["bun test test/retry.test.ts"],
  }),
  // Deliberately reverse all sortable values. The rendered contract must not depend on insertion order.
  nodes: [
    new AdaptiveRoadmap.Node({
      id: "timer-core",
      title: "Timer core",
      goal: "Expose deterministic timer behavior.",
      status: "ready",
      interfaces: [],
      dependencies: [],
      details: [],
      acceptance: ["bun test test/timer.test.ts"],
      risks: [],
      unresolved: [],
    }),
    new AdaptiveRoadmap.Node({
      id: "retry-core",
      title: "Retry core",
      goal: "Implement deterministic retries.",
      status: "running",
      owner: workerID,
      interfaces: [
        new AdaptiveRoadmap.InterfaceRef({
          key: "contract:retry-options",
          name: "RetryOptions",
          kind: "type",
          signature: "type RetryOptions = { retries: number }",
          version: 1,
          state: "ready",
        }),
        new AdaptiveRoadmap.InterfaceRef({
          key: "contract:retry-api",
          name: "retry",
          kind: "function",
          signature: "retry<T>(operation, options): Promise<T>",
          version: 2,
          state: "ready",
        }),
      ],
      dependencies: [
        new AdaptiveRoadmap.Dependency({
          nodeID: "timer-core",
          kind: "hard",
          reason: "timer behavior must be integrated",
        }),
      ],
      details: [
        new AdaptiveRoadmap.DetailRef({
          key: "retry-requirements",
          kind: "requirements",
          version: 1,
          status: "ready",
        }),
        new AdaptiveRoadmap.DetailRef({
          key: "contract:retry-api",
          kind: "contracts",
          version: 2,
          status: "ready",
        }),
      ],
      acceptance: ["bun test test/retry.test.ts"],
      risks: ["flaky clocks"],
      unresolved: ["retry method"],
    }),
  ],
  risks: ["external condition"],
  unresolved: ["determine retry backoff"],
})

describe("AdaptiveContextRender", () => {
  test("renders a complete Roadmap in a byte-stable semantic order", () => {
    const first = AdaptiveContextRender.roadmap(roadmap)
    const second = AdaptiveContextRender.roadmap(roadmap)

    expect(first).toBe(`# Requirement Baseline
Objective: Keep retry behavior consistent.
Scope:
- worker
- timer
Constraints:
- no provider call
Acceptance:
- bun test test/retry.test.ts

# Roadmap r3
## retry-core [running]
Title: Retry core
Owner: ${workerID}
Goal: Implement deterministic retries.
Interfaces:
- retry | function | retry<T>(operation, options): Promise<T> | contract:retry-api@2 [ready]
- RetryOptions | type | type RetryOptions = { retries: number } | contract:retry-options@1 [ready]
Dependencies:
- hard: timer-core - timer behavior must be integrated
Details:
- contracts: contract:retry-api@2 [ready]
- requirements: retry-requirements@1 [ready]
Acceptance:
- bun test test/retry.test.ts
Risks:
- flaky clocks
Unresolved:
- retry method

## timer-core [ready]
Title: Timer core
Owner: unassigned
Goal: Expose deterministic timer behavior.
Interfaces:
Dependencies:
Details:
Acceptance:
- bun test test/timer.test.ts

# Roadmap Risks:
- external condition
# Roadmap Unresolved:
- determine retry backoff`)
    expect(second).toBe(first)
    expect(Hash.sha256(second)).toBe(Hash.sha256(first))
    const ownerChanged = new AdaptiveRoadmap.Info({
      taskID: roadmap.taskID,
      revision: roadmap.revision,
      requirement: roadmap.requirement,
      nodes: roadmap.nodes.map((node) =>
        node.id === "retry-core"
          ? new AdaptiveRoadmap.Node({
              id: node.id,
              title: node.title,
              goal: node.goal,
              status: node.status,
              owner: AdaptiveTask.AgentID.create(),
              interfaces: node.interfaces,
              dependencies: node.dependencies,
              details: node.details,
              acceptance: node.acceptance,
              risks: node.risks,
              unresolved: node.unresolved,
            })
          : node,
      ),
      risks: roadmap.risks,
      unresolved: roadmap.unresolved,
    })

    expect(AdaptiveContextRender.roadmap(ownerChanged)).not.toBe(first)
    expect(Hash.sha256(AdaptiveContextRender.roadmap(ownerChanged))).not.toBe(Hash.sha256(first))
  })

  test("renders Assignment, Detail, and Checkpoint collections in stable order", () => {
    const assignment = new AdaptiveOperation.Assignment({
      id: AdaptiveOperation.AssignmentID.create(),
      taskID,
      workerID,
      nodeID: "retry-core",
      roadmapRevision: 3,
      detailRefs: [
        new AdaptiveRoadmap.DetailRef({ key: "retry-requirements", kind: "requirements", version: 1, status: "ready" }),
        new AdaptiveRoadmap.DetailRef({ key: "contract:retry-api", kind: "contracts", version: 2, status: "ready" }),
      ],
      permittedPaths: [
        AdaptiveOperation.RepositoryGlob.make("src/retry/**"),
        AdaptiveOperation.RepositoryGlob.make("src/timer/**"),
      ],
      baseCommit: "abc123",
      acceptanceCommands: ["bun test test/timer.test.ts", "bun test test/retry.test.ts"],
      generation: 2,
      timeCreated: 1,
    })
    const checkpoint = new AdaptiveOperation.Checkpoint({
      assignmentID: assignment.id,
      workerID,
      generation: 2,
      sequence: 4,
      eventCursor: 9,
      roadmapRevision: 3,
      nodeID: "retry-core",
      completed: ["wire timer", "add retry"],
      decisions: [
        new AdaptiveOperation.VersionRef({ key: "retry-policy", version: 2 }),
        new AdaptiveOperation.VersionRef({ key: "backoff", version: 1 }),
      ],
      modifiedPaths: [
        AdaptiveOperation.RepositoryPath.make("src/retry/retry.ts"),
        AdaptiveOperation.RepositoryPath.make("src/retry/backoff.ts"),
      ],
      evidence: ["validation:retry", "test:retry"],
      remaining: ["run integration", "document behavior"],
      nextAction: "Run validation.",
      worktreeHead: "abc123",
      diffHash: hash("a"),
      timeCreated: 2,
    })
    const detail = new AdaptiveEvent.DetailRecord({
      nodeID: "retry-core",
      ref: new AdaptiveRoadmap.DetailRef({
        key: "retry-requirements",
        kind: "requirements",
        version: 1,
        status: "ready",
      }),
      body: "Keep the exact requirement prose.\n\nDo not summarize it.",
      contentHash: hash("b"),
    })

    expect(AdaptiveContextRender.assignment(assignment)).toBe(`# Assignment ${assignment.id}
Node: retry-core
Roadmap Revision: r3
Generation: 2
Base Commit: abc123
Detail References:
- contracts: contract:retry-api@2 [ready]
- requirements: retry-requirements@1 [ready]
Permitted Paths:
- src/retry/**
- src/timer/**
Acceptance Commands:
- bun test test/timer.test.ts
- bun test test/retry.test.ts`)
    expect(AdaptiveContextRender.checkpoint(checkpoint)).toBe(`# Checkpoint 4
Node: retry-core
Roadmap Revision: r3
Generation: 2
Event Cursor: 9
Worktree Head: abc123
Diff Hash: ${checkpoint.diffHash}
Completed:
- add retry
- wire timer
Decisions:
- backoff@1
- retry-policy@2
Modified Paths:
- src/retry/backoff.ts
- src/retry/retry.ts
Evidence:
- test:retry
- validation:retry
Remaining:
- document behavior
- run integration
Next Action:
Run validation.`)
    expect(AdaptiveContextRender.detail(detail)).toBe(`# Detail requirements: retry-requirements@1 [ready]
Node: retry-core
Content Hash: ${detail.contentHash}

Keep the exact requirement prose.

Do not summarize it.`)
  })
})

describe("AdaptiveContextComponent", () => {
  test("estimates tokens from rendered text and rejects duplicate component keys", () => {
    const text = AdaptiveContextRender.roadmap(roadmap)
    const input = {
      key: "roadmap:r3",
      kind: "roadmap" as const,
      priority: "mandatory" as const,
      sourceRevision: "roadmap:3",
      text,
      evictable: false,
    }
    const components = AdaptiveContextComponent.create([input])

    expect(components).toEqual([{ ...input, estimatedTokens: Token.estimate(text) }])
    expect(() => AdaptiveContextComponent.create([input, input])).toThrow(AdaptiveContextComponent.DuplicateKeyError)
  })
})
