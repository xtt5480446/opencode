const tutorialDirectory = "docs/adaptive-runtime/tutorials/"
const indexPath = `${tutorialDirectory}README.md`
const tutorialPathPattern = /^docs\/adaptive-runtime\/tutorials\/(s\d{2}-t\d{2})-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/

export type Change = {
  readonly status: string
  readonly path: string
}

export type ValidationInput = {
  readonly baseRef: string
  readonly body: string
  readonly labels: readonly string[]
  readonly changes: readonly Change[]
  readonly readFile: (path: string) => Promise<string>
}

export type PullRequestEventInput = {
  readonly event: unknown
  readonly runGit?: (args: readonly string[]) => Promise<string>
}

export const requiredHeadings = [
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

const taskField = /^Adaptive Runtime Task:\s*`(S\d{2}-T\d{2})`\s*$/m
const tutorialField = /^Adaptive Runtime Tutorial:\s*`([^`]+)`\s*$/m
const confirmation = /^- \[[xX]\] I added and indexed the required Adaptive Runtime implementation tutorial\.\s*$/m

export async function validateAdaptiveTutorial(input: ValidationInput): Promise<readonly string[]> {
  const stage = input.baseRef.match(/^stage-(\d{2})$/)?.[1]
  if (!stage || input.labels.includes("tutorial-exempt")) return []

  const errors: string[] = []
  const task = input.body.match(taskField)?.[1]
  const tutorialPath = input.body.match(tutorialField)?.[1]

  if (!task) errors.push("PR body must declare Adaptive Runtime Task as Sxx-Txx.")
  if (!tutorialPath || !tutorialPathPattern.test(tutorialPath)) {
    errors.push("PR body must declare one canonical Adaptive Runtime Tutorial path.")
  }
  if (!confirmation.test(input.body)) errors.push("Adaptive Runtime tutorial confirmation is not checked.")

  if (task && task.slice(1, 3) !== stage) {
    errors.push(`Task ${task} does not belong to base branch ${input.baseRef}.`)
  }
  if (task && tutorialPath && !tutorialPath.startsWith(`${tutorialDirectory}${task.toLowerCase()}-`)) {
    errors.push(`Tutorial path must start with ${tutorialDirectory}${task.toLowerCase()}-.`)
  }

  const addedTutorials = input.changes.filter(
    (change) => change.status === "A" && tutorialPathPattern.test(change.path),
  )
  const declaredAdded = tutorialPath
    ? input.changes.some((change) => change.status === "A" && change.path === tutorialPath)
    : false
  if (tutorialPath && !declaredAdded) errors.push(`Declared tutorial must be newly added in this PR: ${tutorialPath}.`)
  if (addedTutorials.length !== 1) {
    errors.push(`A stage task PR must add exactly one implementation tutorial; found ${addedTutorials.length}.`)
  } else if (tutorialPath && addedTutorials[0]?.path !== tutorialPath) {
    errors.push(
      "A stage task PR must add exactly one implementation tutorial; found 1 but it does not match the declared path.",
    )
  }

  const indexChanged = input.changes.some((change) => change.path === indexPath)
  if (!indexChanged) errors.push("Tutorial index must change in the same PR.")

  if (tutorialPath && tutorialPathPattern.test(tutorialPath) && declaredAdded) {
    const filename = tutorialPath.split("/").at(-1)!
    if (indexChanged) {
      const index = await read(input, indexPath, errors)
      if (index !== undefined && !index.includes(`](./${filename})`)) {
        errors.push(`Tutorial index does not link ${filename}.`)
      }
    }
    const tutorial = await read(input, tutorialPath, errors)
    if (tutorial !== undefined) validateTutorial(tutorial, errors)
  }

  return errors
}

export async function validatePullRequestEvent(input: PullRequestEventInput) {
  const event = asRecord(input.event, "event")
  const pullRequest = asRecord(event.pull_request, "event.pull_request")
  const base = asRecord(pullRequest.base, "event.pull_request.base")
  const head = asRecord(pullRequest.head, "event.pull_request.head")
  const baseRef = requireString(base.ref, "event.pull_request.base.ref")
  const baseSha = requireSha(base.sha)
  const headSha = requireSha(head.sha)
  const labels = Array.isArray(pullRequest.labels)
    ? pullRequest.labels.map((label) => requireString(asRecord(label, "pull_request.label").name, "label.name"))
    : []
  const runGit = input.runGit ?? git
  const changes = parseChanges(await runGit(["diff", "--name-status", baseSha, headSha]))
  return validateAdaptiveTutorial({
    baseRef,
    body: typeof pullRequest.body === "string" ? pullRequest.body : "",
    labels,
    changes,
    readFile: (path) => runGit(["show", `${headSha}:${path}`]),
  })
}

async function read(input: ValidationInput, path: string, errors: string[]) {
  try {
    return await input.readFile(path)
  } catch (error) {
    errors.push(`Unable to read ${path}: ${error instanceof Error ? error.message : String(error)}.`)
  }
}

function validateTutorial(tutorial: string, errors: string[]) {
  if (tutorial.includes("<!-- tutorial:")) {
    errors.push("Tutorial still contains authoring markers from TEMPLATE.md.")
  }

  const lines = tutorial.split("\n")
  const indexes = requiredHeadings.map((heading) => lines.findIndex((line) => line.trim() === heading))
  for (let index = 0; index < requiredHeadings.length; index++) {
    const heading = requiredHeadings[index]!
    const line = indexes[index]!
    if (line < 0) {
      errors.push(`Tutorial is missing required heading: ${heading}.`)
      continue
    }
    const previous = indexes
      .slice(0, index)
      .filter((value) => value >= 0)
      .at(-1)
    if (previous !== undefined && line <= previous) {
      errors.push(`Tutorial headings are out of order at: ${heading}.`)
    }
    const next = lines.findIndex((value, position) => position > line && /^##\s/.test(value))
    const content = lines.slice(line + 1, next < 0 ? lines.length : next).join("\n")
    if ((content.match(/[\p{L}\p{N}]/gu) ?? []).length < 40) {
      errors.push(`Tutorial section has insufficient content: ${heading}.`)
    }
  }
}

function parseChanges(output: string): readonly Change[] {
  return output
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const fields = line.split("\t")
      return { status: fields[0]!, path: fields.at(-1)! }
    })
}

function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Missing ${field}`)
  return value as Record<string, unknown>
}

function requireString(value: unknown, field: string) {
  if (typeof value !== "string") throw new Error(`Missing ${field}`)
  return value
}

function requireSha(value: unknown) {
  if (typeof value !== "string" || !/^[0-9a-f]{40,64}$/.test(value)) {
    throw new Error("Pull request event contains an invalid Git SHA")
  }
  return value
}

async function git(args: readonly string[]) {
  const child = Bun.spawn(["git", ...args], { stdout: "pipe", stderr: "pipe" })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  if (exitCode !== 0) throw new Error(stderr.trim() || `git ${args[0]} exited with status ${exitCode}`)
  return stdout
}

if (import.meta.main) {
  const eventPath = process.env.GITHUB_EVENT_PATH
  if (!eventPath) throw new Error("GITHUB_EVENT_PATH is required")
  const errors = await validatePullRequestEvent({ event: await Bun.file(eventPath).json() })
  if (errors.length) {
    console.error(["Adaptive Runtime tutorial check failed:", ...errors.map((error) => `- ${error}`)].join("\n"))
    process.exit(1)
  }
  console.log("Adaptive Runtime tutorial check passed")
}
