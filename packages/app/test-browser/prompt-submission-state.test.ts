import { describe, expect, test } from "bun:test"
import { createPromptState } from "@/context/prompt"
import { createPromptSubmissionState } from "@/components/prompt-input/submission-state"

describe("prompt submission state", () => {
  test("keeps failed submission restoration with the prompt where it started", () => {
    const target = createPromptState()
    const submission = createPromptSubmissionState({
      target,
      prompt: [{ type: "text", content: "prompt-A", start: 0, end: 8 }],
      context: [{ key: "file:src/index.ts:undefined:undefined", type: "file", path: "src/index.ts" }],
    })

    expect(submission.restore()).toEqual({
      target,
      prompt: [{ type: "text", content: "prompt-A", start: 0, end: 8 }],
      context: [{ key: "file:src/index.ts:undefined:undefined", type: "file", path: "src/index.ts" }],
    })
  })

  test("moves first-submit restoration and context to the promoted session", () => {
    const draft = createPromptState()
    const session = createPromptState()
    const submission = createPromptSubmissionState({
      target: draft,
      prompt: [{ type: "text", content: "first prompt", start: 0, end: 12 }],
      context: [{ key: "file:src/index.ts:undefined:undefined", type: "file", path: "src/index.ts" }],
    })

    submission.retarget(session)

    expect(submission.restore()).toEqual({
      target: session,
      prompt: [{ type: "text", content: "first prompt", start: 0, end: 12 }],
      context: [{ key: "file:src/index.ts:undefined:undefined", type: "file", path: "src/index.ts" }],
    })
    expect(session.context.items()).toHaveLength(1)
    expect(session.context.items()[0]).toMatchObject({ type: "file", path: "src/index.ts" })
  })

  test("clears the original draft after first-submit promotion", () => {
    const draft = createPromptState()
    const session = createPromptState()
    draft.set([{ type: "text", content: "first prompt", start: 0, end: 12 }])
    draft.context.add({ type: "file", path: "src/index.ts" })
    const submission = createPromptSubmissionState({
      target: draft,
      prompt: draft.current(),
      context: draft.context.items().slice(),
    })

    submission.retarget(session)
    submission.clear()

    expect(draft.current()).toEqual([{ type: "text", content: "", start: 0, end: 0 }])
    expect(draft.context.items()).toEqual([])
    expect(session.current()).toEqual([{ type: "text", content: "", start: 0, end: 0 }])
    expect(session.context.items()).toHaveLength(1)
    expect(session.context.items()[0]).toMatchObject({ type: "file", path: "src/index.ts" })
  })

  test("restores prompt and context to the promoted session after a cleared submit fails", () => {
    const draft = createPromptState()
    const session = createPromptState()
    draft.set([{ type: "text", content: "first prompt", start: 0, end: 12 }])
    draft.context.add({ type: "file", path: "src/index.ts" })
    const submission = createPromptSubmissionState({
      target: draft,
      prompt: draft.current(),
      context: draft.context.items().slice(),
    })

    submission.retarget(session)
    submission.clear()
    const restored = submission.restore()
    restored?.target.set(restored.prompt)

    expect(draft.current()).toEqual([{ type: "text", content: "", start: 0, end: 0 }])
    expect(draft.context.items()).toEqual([])
    expect(session.current()).toEqual([{ type: "text", content: "first prompt", start: 0, end: 12 }])
    expect(session.context.items()).toHaveLength(1)
    expect(session.context.items()[0]).toMatchObject({ type: "file", path: "src/index.ts" })
  })

  test("does not clear an original draft edited after submission started", () => {
    const draft = createPromptState()
    const session = createPromptState()
    draft.set([{ type: "text", content: "submitted", start: 0, end: 9 }])
    const submission = createPromptSubmissionState({
      target: draft,
      prompt: draft.current(),
      context: [],
    })

    submission.retarget(session)
    draft.set([{ type: "text", content: "new draft", start: 0, end: 9 }])
    submission.clear()

    expect(draft.current()).toEqual([{ type: "text", content: "new draft", start: 0, end: 9 }])
    expect(session.current()).toEqual([{ type: "text", content: "", start: 0, end: 0 }])
  })

  test("does not restore over a prompt edited after submission", () => {
    const target = createPromptState()
    target.set([{ type: "text", content: "submitted", start: 0, end: 9 }])
    const submission = createPromptSubmissionState({
      target,
      prompt: target.current(),
      context: [],
    })

    submission.clear()
    target.set([{ type: "text", content: "new draft", start: 0, end: 9 }])

    expect(submission.restore()).toBeUndefined()
    expect(target.current()[0]).toMatchObject({ type: "text", content: "new draft" })
  })
})
