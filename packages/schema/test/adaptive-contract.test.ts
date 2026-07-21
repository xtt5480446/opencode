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
import { RelativePath } from "../src/schema"

describe("Adaptive recovery contracts", () => {
  test("Roadmap round trip preserves complete interface index and exact Detail version", () => {
    const value = new AdaptiveRoadmap.Info({
      taskID: AdaptiveTask.ID.create(),
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
      permittedPaths: [RelativePath.make("src/retry.ts"), RelativePath.make("test/retry.test.ts")],
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
      modifiedPaths: [RelativePath.make("src/retry.ts")],
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

  test("rejects generation zero and unbounded Tool previews at the contract boundary", () => {
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

    expect(() =>
      Schema.decodeUnknownSync(AdaptiveEvent.ToolCalled)({
        id: Event.ID.create(),
        type: AdaptiveEvent.ToolCalled.type,
        data: {
          taskID,
          timeCreated: 1,
          agentID: workerID,
          generation: 1,
          tool: "read",
          callID: "call-1",
          inputPreview: "x".repeat(8193),
        },
      }),
    ).toThrow()
  })

  test("root and direct entrypoints preserve canonical Adaptive contract identity", () => {
    expect(RootAdaptiveRoadmap.Info).toBe(AdaptiveRoadmap.Info)
    expect(RootAdaptiveOperation.Checkpoint).toBe(AdaptiveOperation.Checkpoint)
    expect(RootAdaptiveEvent.Durable).toBe(AdaptiveEvent.Durable)
  })
})
