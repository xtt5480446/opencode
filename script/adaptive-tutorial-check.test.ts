import { describe, expect, test } from "bun:test"
import { validateAdaptiveTutorial, type ValidationInput } from "./adaptive-tutorial-check"

const task = "S01-T03"
const tutorialPath = "docs/adaptive-runtime/tutorials/s01-t03-foundation-store.md"
const indexPath = "docs/adaptive-runtime/tutorials/README.md"
const headings = [
  "## 先说结论",
  "## 它在当前 Milestone 中的位置",
  "## OpenCode baseline 与复用边界",
  "## 最终实现",
  "## 推荐代码阅读路线",
  "## 术语释义",
  "## 测试看护逻辑",
  "## 亲手验证",
  "## 当前边界与下一步",
] as const

const section = "这一节提供足够具体的中文说明，并引用真实的 EnglishCodeSymbol、测试风险、实现边界和可验证结果。"
const completeTutorial = headings.map((heading) => `${heading}\n\n${section}`).join("\n\n") + "\n"
const completeBody = [
  `Adaptive Runtime Task: \`${task}\``,
  `Adaptive Runtime Tutorial: \`${tutorialPath}\``,
  "- [x] I added and indexed the required Adaptive Runtime implementation tutorial.",
].join("\n")

function validInput(overrides: Partial<ValidationInput> = {}): ValidationInput {
  const files = new Map([
    [tutorialPath, completeTutorial],
    [indexPath, `[S01-T03 Foundation Store](./${tutorialPath.split("/").at(-1)})\n`],
  ])
  return {
    baseRef: "stage-01",
    body: completeBody,
    labels: [],
    changes: [
      { status: "A", path: tutorialPath },
      { status: "M", path: indexPath },
    ],
    readFile: async (path) => {
      const value = files.get(path)
      if (value === undefined) throw new Error(`Missing fixture ${path}`)
      return value
    },
    ...overrides,
  }
}

describe("adaptive tutorial check", () => {
  test("does not impose Adaptive requirements on ordinary OpenCode PRs", async () => {
    expect(
      await validateAdaptiveTutorial({
        baseRef: "main",
        body: "",
        labels: [],
        changes: [],
        readFile: async () => "",
      }),
    ).toEqual([])
  })

  test("accepts one complete indexed tutorial for the declared stage task", async () => {
    expect(await validateAdaptiveTutorial(validInput())).toEqual([])
  })

  test("reports every missing PR declaration in one pass", async () => {
    expect(await validateAdaptiveTutorial(validInput({ body: "" }))).toEqual(
      expect.arrayContaining([
        "PR body must declare Adaptive Runtime Task as Sxx-Txx.",
        "PR body must declare one canonical Adaptive Runtime Tutorial path.",
        "Adaptive Runtime tutorial confirmation is not checked.",
      ]),
    )
  })

  test("rejects a task whose stage differs from the base branch", async () => {
    expect(await validateAdaptiveTutorial(validInput({ baseRef: "stage-02" }))).toContain(
      "Task S01-T03 does not belong to base branch stage-02.",
    )
  })

  test("rejects a tutorial path for another task", async () => {
    const body = completeBody.replace("s01-t03-foundation-store.md", "s01-t04-model-resolution.md")
    expect(await validateAdaptiveTutorial(validInput({ body }))).toContain(
      "Tutorial path must start with docs/adaptive-runtime/tutorials/s01-t03-.",
    )
  })

  test("requires exactly one newly added implementation tutorial", async () => {
    expect(
      await validateAdaptiveTutorial(
        validInput({
          changes: [
            { status: "M", path: tutorialPath },
            { status: "A", path: "docs/adaptive-runtime/tutorials/s01-t03-extra.md" },
            { status: "M", path: indexPath },
          ],
        }),
      ),
    ).toEqual(
      expect.arrayContaining([
        `Declared tutorial must be newly added in this PR: ${tutorialPath}.`,
        "A stage task PR must add exactly one implementation tutorial; found 1 but it does not match the declared path.",
      ]),
    )

    expect(
      await validateAdaptiveTutorial(
        validInput({
          changes: [
            { status: "A", path: tutorialPath },
            { status: "A", path: "docs/adaptive-runtime/tutorials/s01-t04-model-resolution.md" },
            { status: "M", path: indexPath },
          ],
        }),
      ),
    ).toContain("A stage task PR must add exactly one implementation tutorial; found 2.")
  })

  test("requires the tutorial index to change and link the declared filename", async () => {
    expect(await validateAdaptiveTutorial(validInput({ changes: [{ status: "A", path: tutorialPath }] }))).toContain(
      "Tutorial index must change in the same PR.",
    )

    expect(
      await validateAdaptiveTutorial(
        validInput({ readFile: async (path) => (path === tutorialPath ? completeTutorial : "no link") }),
      ),
    ).toContain("Tutorial index does not link s01-t03-foundation-store.md.")
  })

  test("rejects missing, out-of-order, and insubstantial required sections", async () => {
    const missing = completeTutorial.replace(`${headings[3]}\n\n${section}\n\n`, "")
    expect(
      await validateAdaptiveTutorial(
        validInput({
          readFile: async (path) => (path === tutorialPath ? missing : `](./${tutorialPath.split("/").at(-1)})`),
        }),
      ),
    ).toContain(`Tutorial is missing required heading: ${headings[3]}.`)

    const reordered = completeTutorial
      .replace(headings[0], "## TEMP")
      .replace(headings[1], headings[0])
      .replace("## TEMP", headings[1])
    expect(
      await validateAdaptiveTutorial(
        validInput({
          readFile: async (path) => (path === tutorialPath ? reordered : `](./${tutorialPath.split("/").at(-1)})`),
        }),
      ),
    ).toContain(`Tutorial headings are out of order at: ${headings[1]}.`)

    const short = completeTutorial.replace(section, "太短")
    expect(
      await validateAdaptiveTutorial(
        validInput({
          readFile: async (path) => (path === tutorialPath ? short : `](./${tutorialPath.split("/").at(-1)})`),
        }),
      ),
    ).toContain(`Tutorial section has insufficient content: ${headings[0]}.`)
  })

  test("rejects an unchanged authoring marker", async () => {
    const marked = completeTutorial.replace(section, `<!-- tutorial:replace-this-guidance -->\n${section}`)
    expect(
      await validateAdaptiveTutorial(
        validInput({
          readFile: async (path) => (path === tutorialPath ? marked : `](./${tutorialPath.split("/").at(-1)})`),
        }),
      ),
    ).toContain("Tutorial still contains authoring markers from TEMPLATE.md.")
  })

  test("allows only the maintainer-controlled exemption label to bypass stage validation", async () => {
    expect(await validateAdaptiveTutorial(validInput({ body: "", labels: ["tutorial-exempt"], changes: [] }))).toEqual(
      [],
    )
    expect(await validateAdaptiveTutorial(validInput({ body: "N/A", changes: [] }))).not.toEqual([])
  })
})
