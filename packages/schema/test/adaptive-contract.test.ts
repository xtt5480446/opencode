import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import {
  AdaptiveEvent as RootAdaptiveEvent,
  AdaptiveOperation as RootAdaptiveOperation,
  AdaptiveRoadmap as RootAdaptiveRoadmap,
} from "../src"
import { AdaptiveEvent } from "../src/adaptive-event"
import { AdaptiveOperation } from "../src/adaptive-operation"
import { AdaptiveRoadmap } from "../src/adaptive-roadmap"
import { AdaptiveTask } from "../src/adaptive-task"
import { Event } from "../src/event"

describe("Adaptive recovery contracts", () => {
  test("Roadmap round trip preserves complete interface index and exact Detail version", () => {
    const value = roadmap(AdaptiveTask.ID.create())

    expect(
      Schema.decodeUnknownSync(AdaptiveRoadmap.Info)(Schema.encodeUnknownSync(AdaptiveRoadmap.Info)(value)),
    ).toEqual(value)
  })

  test("Assignment and Checkpoint carry the exact handoff facts needed by a replacement", () => {
    const taskID = AdaptiveTask.ID.create()
    const workerID = AdaptiveTask.AgentID.create()
    const assignmentID = AdaptiveOperation.AssignmentID.create()
    const detail = new AdaptiveRoadmap.DetailRef({
      key: "contract:retry-api",
      kind: "contracts",
      version: 2,
      status: "ready",
    })
    const assignment = new AdaptiveOperation.Assignment({
      id: assignmentID,
      taskID,
      workerID,
      nodeID: "retry-core",
      roadmapRevision: 3,
      detailRefs: [detail],
      permittedPaths: [
        AdaptiveOperation.RepositoryGlob.make("src/retry.ts"),
        AdaptiveOperation.RepositoryGlob.make("test/retry.test.ts"),
      ],
      baseCommit: "abc123",
      acceptanceCommands: ["bun test test/retry.test.ts"],
      generation: 2,
      timeCreated: 1,
    })
    const checkpoint = new AdaptiveOperation.Checkpoint({
      assignmentID,
      workerID,
      generation: 2,
      sequence: 4,
      eventCursor: 10,
      roadmapRevision: 3,
      nodeID: "retry-core",
      completed: ["added cancellation branch"],
      decisions: [new AdaptiveOperation.VersionRef({ key: "decision:timer", version: 1 })],
      modifiedPaths: [AdaptiveOperation.RepositoryPath.make("src/retry.ts")],
      evidence: ["aev_test"],
      remaining: ["backoff assertion fails"],
      nextAction: "fix attempt counter",
      worktreeHead: "abc123",
      diffHash: `sha256:${"a".repeat(64)}`,
      timeCreated: 2,
    })

    expect(assignment.detailRefs).toEqual([detail])
    expect(checkpoint.nextAction).toBe("fix attempt counter")
    expect(checkpoint.eventCursor).toBe(10)
    expect(
      Schema.decodeUnknownSync(AdaptiveOperation.Checkpoint)(
        Schema.encodeUnknownSync(AdaptiveOperation.Checkpoint)(checkpoint),
      ),
    ).toEqual(checkpoint)
  })

  test("RoadmapCommitted carries every new Detail body needed for replay", () => {
    const taskID = AdaptiveTask.ID.create()
    const roadmapValue = roadmap(taskID)
    const detail = {
      nodeID: "retry-core",
      ref: roadmapValue.nodes[0].details[0],
      body: "retry<T>(operation, options): Promise<T>",
      contentHash: `sha256:${"b".repeat(64)}`,
    }
    const decoded = Schema.decodeUnknownSync(AdaptiveEvent.RoadmapCommitted)({
      id: Event.ID.create(),
      type: AdaptiveEvent.RoadmapCommitted.type,
      data: {
        taskID,
        timeCreated: 1,
        roadmap: roadmapValue,
        details: [detail],
        contentHash: `sha256:${"a".repeat(64)}`,
        sourceAgentID: AdaptiveTask.AgentID.create(),
        sourceGeneration: 1,
      },
    })

    expect("details" in decoded.data && decoded.data.details).toEqual([detail])
  })

  test("rejects generation zero at the contract boundary", () => {
    const taskID = AdaptiveTask.ID.create()
    const workerID = AdaptiveTask.AgentID.create()
    expect(() =>
      Schema.decodeUnknownSync(AdaptiveOperation.Assignment)({
        id: AdaptiveOperation.AssignmentID.create(),
        taskID,
        workerID,
        nodeID: "retry-core",
        roadmapRevision: 1,
        detailRefs: [],
        permittedPaths: [],
        baseCommit: "abc123",
        acceptanceCommands: [],
        generation: 0,
        timeCreated: 1,
      }),
    ).toThrow()
  })

  test("Tool payloads require canonical hashes and durable content when previews are incomplete", () => {
    const taskID = AdaptiveTask.ID.create()
    const workerID = AdaptiveTask.AgentID.create()
    const decode = Schema.decodeUnknownSync(AdaptiveEvent.ToolCalled)
    const event = {
      id: Event.ID.create(),
      type: AdaptiveEvent.ToolCalled.type,
      data: {
        taskID,
        timeCreated: 1,
        agentID: workerID,
        generation: 1,
        tool: "read",
        callID: "call-1",
        input: {
          hash: `sha256:${"c".repeat(64)}`,
          preview: "{}",
          complete: true,
        },
      },
    }
    const decoded = decode(event)
    expect("input" in decoded.data && decoded.data.input).toEqual(event.data.input)
    const conflicting = decode({
      ...event,
      data: {
        ...event.data,
        input: { ...event.data.input, hash: `sha256:${"d".repeat(64)}` },
      },
    })
    expect("input" in conflicting.data && conflicting.data.input.hash).not.toBe(
      "input" in decoded.data && decoded.data.input.hash,
    )

    expect(() =>
      decode({
        ...event,
        data: { ...event.data, input: { ...event.data.input, complete: false } },
      }),
    ).toThrow()
    expect(() =>
      decode({
        ...event,
        data: {
          ...event.data,
          input: { hash: event.data.input.hash, complete: true },
        },
      }),
    ).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(AdaptiveEvent.ToolCalled)({
        ...event,
        data: { ...event.data, input: { ...event.data.input, preview: "x".repeat(8193) } },
      }),
    ).toThrow()
  })

  test("rejects absolute and traversing repository paths and globs", () => {
    const decodePath = Schema.decodeUnknownSync(AdaptiveOperation.RepositoryPath)
    const decodeGlob = Schema.decodeUnknownSync(AdaptiveOperation.RepositoryGlob)

    expect(String(decodePath("src/retry.ts" as unknown))).toBe("src/retry.ts")
    expect(String(decodeGlob("src/**" as unknown))).toBe("src/**")
    for (const path of ["/tmp/secret", "../secret", "src/../../secret", "C:\\secret", "src//file", "./src"]) {
      expect(() => decodePath(path as unknown)).toThrow()
      expect(() => decodeGlob(path as unknown)).toThrow()
    }
  })

  test("RecoveryVerification and CandidateReport preserve auditable workspace facts", () => {
    const workerID = AdaptiveTask.AgentID.create()
    const assignmentID = AdaptiveOperation.AssignmentID.create()
    const path = AdaptiveOperation.RepositoryPath.make("src/retry.ts")
    const detail = new AdaptiveRoadmap.DetailRef({
      key: "contract:retry-api",
      kind: "contracts",
      version: 2,
      status: "ready",
    })
    const verification = new AdaptiveOperation.RecoveryVerification({
      assignmentID,
      workerID,
      generation: 3,
      roadmapRevision: 3,
      observedHead: "abc123",
      diffHash: `sha256:${"a".repeat(64)}`,
      statusLines: ["M src/retry.ts"],
      keyFiles: [new AdaptiveOperation.KeyFile({ path, contentHash: `sha256:${"b".repeat(64)}` })],
      revalidatedEvidence: ["aev_test"],
      discrepancies: [],
      consistent: true,
      timeCreated: 3,
    })
    const candidate = new AdaptiveOperation.CandidateReport({
      assignmentID,
      workerID,
      generation: 3,
      nodeID: "retry-core",
      headCommit: "def456",
      diffHash: `sha256:${"c".repeat(64)}`,
      modifiedPaths: [path],
      evidence: ["aev_test"],
      remainingRisks: [],
      detailRefs: [detail],
      timeCreated: 4,
    })

    expect(
      Schema.decodeUnknownSync(AdaptiveOperation.RecoveryVerification)(
        Schema.encodeUnknownSync(AdaptiveOperation.RecoveryVerification)(verification),
      ),
    ).toEqual(verification)
    expect(
      Schema.decodeUnknownSync(AdaptiveOperation.CandidateReport)(
        Schema.encodeUnknownSync(AdaptiveOperation.CandidateReport)(candidate),
      ),
    ).toEqual(candidate)
  })

  test("root and direct entrypoints preserve canonical Adaptive contract identity", () => {
    expect(RootAdaptiveRoadmap.Info).toBe(AdaptiveRoadmap.Info)
    expect(RootAdaptiveOperation.Checkpoint).toBe(AdaptiveOperation.Checkpoint)
    expect(RootAdaptiveEvent.Durable).toBe(AdaptiveEvent.Durable)
  })
})

function roadmap(taskID: AdaptiveTask.ID) {
  return new AdaptiveRoadmap.Info({
    taskID,
    revision: 3,
    requirement: new AdaptiveRoadmap.RequirementBaseline({
      objective: "implement retry",
      scope: ["src/retry.ts"],
      constraints: ["one pinned model"],
      acceptance: ["bun test"],
    }),
    nodes: [
      new AdaptiveRoadmap.Node({
        id: "retry-core",
        title: "Retry core",
        goal: "bounded cancellable retry",
        status: "running",
        interfaces: [
          new AdaptiveRoadmap.InterfaceRef({
            key: "contract:retry-api",
            name: "retry",
            kind: "function",
            signature: "retry<T>(operation, options): Promise<T>",
            version: 2,
            state: "ready",
          }),
        ],
        dependencies: [],
        details: [
          new AdaptiveRoadmap.DetailRef({
            key: "contract:retry-api",
            kind: "contracts",
            version: 2,
            status: "ready",
          }),
        ],
        acceptance: ["bun test test/retry.test.ts"],
        risks: [],
        unresolved: [],
      }),
    ],
    risks: [],
    unresolved: [],
  })
}
