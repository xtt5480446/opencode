export type StageDefinition = {
  readonly stage: number
  readonly milestone: string
  readonly planFile: string
  readonly estimate: string
  readonly evidence: string
}

export type DiscoveredTask = {
  readonly key: string
  readonly stage: number
  readonly task: number
  readonly title: string
  readonly planFile: string
  readonly anchor: string
  readonly files: readonly string[]
}

export type TaskSpec = DiscoveredTask & {
  readonly dependencies: readonly string[]
  readonly labels: readonly string[]
  readonly branch: string
  readonly targetBranch: string
  readonly milestone: string
  readonly evidence: string
}

export type LabelDefinition = {
  readonly name: string
  readonly color: string
  readonly description: string
}

export type MilestoneRecord = { readonly number: number; readonly title: string }
export type IssueRecord = {
  readonly number: number
  readonly nodeID: string
  readonly title: string
  readonly body: string
  readonly state: "open" | "closed"
}
export type ProjectRecord = { readonly id: string; readonly number: number; readonly url: string }

export interface GitHubBootstrapClient {
  readonly listLabels: () => Promise<readonly { readonly name: string }[]>
  readonly createLabel: (input: LabelDefinition) => Promise<void>
  readonly listMilestones: () => Promise<readonly MilestoneRecord[]>
  readonly createMilestone: (input: {
    readonly title: string
    readonly description: string
  }) => Promise<MilestoneRecord>
  readonly listIssues: () => Promise<readonly IssueRecord[]>
  readonly createIssue: (input: {
    readonly title: string
    readonly body: string
    readonly labels: readonly string[]
    readonly milestone: number
  }) => Promise<IssueRecord>
  readonly updateIssue: (number: number, input: { readonly body: string }) => Promise<IssueRecord>
  readonly getProject: () => Promise<ProjectRecord | undefined>
  readonly createProject: (input: {
    readonly title: string
    readonly shortDescription: string
    readonly readme: string
  }) => Promise<ProjectRecord>
  readonly updateProject: (
    projectID: string,
    input: {
      readonly shortDescription: string
      readonly readme: string
    },
  ) => Promise<void>
  readonly listProjectIssueNumbers: (projectID: string) => Promise<ReadonlySet<number>>
  readonly addProjectItems: (
    projectID: string,
    issues: readonly Pick<IssueRecord, "number" | "nodeID">[],
  ) => Promise<void>
}

export const projectTitle = "Adaptive Runtime Commercial V1"

export const desiredLabels: readonly LabelDefinition[] = [
  { name: "adaptive-runtime", color: "0E8A16", description: "Adaptive Runtime Commercial V1 work" },
  { name: "stage:1", color: "1D76DB", description: "G1 execution foundation" },
  { name: "stage:2", color: "1D76DB", description: "G2 state, context, and recovery" },
  { name: "stage:3", color: "1D76DB", description: "G3 Roadmap and Coordinator" },
  { name: "stage:4", color: "1D76DB", description: "G4 workers, workspaces, and contracts" },
  { name: "stage:5", color: "1D76DB", description: "G5 validation, integration, and operations" },
  { name: "stage:6", color: "1D76DB", description: "G6 commercial hardening" },
  { name: "kind:feature", color: "A2EEEF", description: "Product implementation task" },
  { name: "kind:test", color: "BFDADC", description: "Test or fixture task" },
  { name: "kind:hardening", color: "D4C5F9", description: "Security, reliability, or release hardening" },
  { name: "kind:gate", color: "FBCA04", description: "Stage integration and user acceptance gate" },
  { name: "user-gate", color: "B60205", description: "Cannot close without explicit user acceptance" },
  {
    name: "tutorial-exempt",
    color: "D93F0B",
    description: "Maintainer-approved non-task stage PR without a new implementation tutorial",
  },
  { name: "area:schema", color: "C5DEF5", description: "Schema and wire contracts" },
  { name: "area:core", color: "C5DEF5", description: "Core deterministic state logic" },
  { name: "area:runtime", color: "C5DEF5", description: "Adaptive execution runtime" },
  { name: "area:context", color: "C5DEF5", description: "Context assembly, tools, and recovery" },
  { name: "area:coordinator", color: "C5DEF5", description: "Roadmap, Coordinator, and Discovery" },
  { name: "area:workspace", color: "C5DEF5", description: "Workers, Git, and workspaces" },
  { name: "area:contracts", color: "C5DEF5", description: "Frozen contracts and worker communication" },
  { name: "area:validation", color: "C5DEF5", description: "Evidence and independent validation" },
  { name: "area:integration", color: "C5DEF5", description: "Integration, conflict, and materialization" },
  { name: "area:api", color: "C5DEF5", description: "CLI, HTTP API, generated clients, and export" },
  { name: "area:security", color: "C5DEF5", description: "Secrets, sensitive paths, and sandboxing" },
  { name: "area:benchmark", color: "C5DEF5", description: "Benchmark validity and model audit" },
  { name: "area:operations", color: "C5DEF5", description: "Observability, backup, load, and recovery operations" },
  { name: "area:release", color: "C5DEF5", description: "Packaging and release readiness" },
]

export const stageDefinitions: readonly StageDefinition[] = [
  {
    stage: 1,
    milestone: "G1",
    planFile: "2026-07-17-adaptive-runtime-01-foundation.md",
    estimate: "6-8 working days",
    evidence:
      "Schema/unit tests, baseline parity, real subprocess supervision, packaged smoke, and the G1 real-model trial.",
  },
  {
    stage: 2,
    milestone: "G2",
    planFile: "2026-07-17-adaptive-runtime-02-state-context-recovery.md",
    estimate: "8-11 working days",
    evidence:
      "Context budget/unit tests, real SQLite, forced process loss, recovery idempotency, and the G2 coding fixture.",
  },
  {
    stage: 3,
    milestone: "G3",
    planFile: "2026-07-17-adaptive-runtime-03-roadmap-coordinator.md",
    estimate: "6-9 working days",
    evidence:
      "Roadmap invariant/CAS tests, Coordinator crash recovery, fixture behavior, and user inspection of Roadmap and Detail quality.",
  },
  {
    stage: 4,
    milestone: "G4",
    planFile: "2026-07-17-adaptive-runtime-04-workers-contracts.md",
    estimate: "10-14 working days",
    evidence:
      "Scheduler unit tests, real Git/worktree concurrency, contract ancestry, dirty/empty workspace preservation, and both G4 user trials.",
  },
  {
    stage: 5,
    milestone: "G5",
    planFile: "2026-07-17-adaptive-runtime-05-validation-integration-operations.md",
    estimate: "11-16 working days",
    evidence:
      "Evidence/completion unit tests, controlled commands, real merge conflicts, API/SDK parity, atomic materialization, and the G5 workflow trial.",
  },
  {
    stage: 6,
    milestone: "G6",
    planFile: "2026-07-17-adaptive-runtime-06-commercial-hardening.md",
    estimate: "14-20 working days",
    evidence:
      "Security and model-validity tests, load/chaos/leak checks, cross-platform package smoke, a 24-hour soak, and the G6 long-task pair.",
  },
]

const dependencies: Readonly<Record<string, readonly string[]>> = {
  "S01-T01": [],
  "S01-T02": ["S01-T01"],
  "S01-T03": ["S01-T01", "S01-T02"],
  "S01-T04": ["S01-T01"],
  "S01-T05": ["S01-T02", "S01-T03"],
  "S01-T06": ["S01-T01"],
  "S01-T07": ["S01-T03", "S01-T06"],
  "S01-T08": ["S01-T04", "S01-T05", "S01-T07"],
  "S01-T09": ["S01-T03", "S01-T07", "S01-T08"],
  "S01-T10": ["S01-T09"],
  "S02-T01": ["S01-T10"],
  "S02-T02": ["S02-T01"],
  "S02-T03": ["S02-T02"],
  "S02-T04": ["S02-T01"],
  "S02-T05": ["S02-T02", "S02-T04"],
  "S02-T06": ["S02-T02", "S02-T04"],
  "S02-T07": ["S02-T05", "S02-T06"],
  "S02-T08": ["S02-T03", "S02-T05", "S02-T06", "S02-T07"],
  "S02-T09": ["S02-T08"],
  "S03-T01": ["S02-T09"],
  "S03-T02": ["S03-T01"],
  "S03-T03": ["S03-T01", "S03-T02"],
  "S03-T04": ["S03-T02", "S03-T03"],
  "S03-T05": ["S03-T04"],
  "S03-T06": ["S03-T04"],
  "S03-T07": ["S03-T04"],
  "S03-T08": ["S03-T04"],
  "S03-T09": ["S03-T05", "S03-T06", "S03-T07", "S03-T08"],
  "S04-T01": ["S03-T09"],
  "S04-T02": ["S04-T01"],
  "S04-T03": ["S03-T09"],
  "S04-T04": ["S04-T03"],
  "S04-T05": ["S04-T03", "S04-T04"],
  "S04-T06": ["S04-T01", "S04-T02"],
  "S04-T07": ["S04-T04", "S04-T05", "S04-T06"],
  "S04-T08": ["S04-T01", "S04-T02"],
  "S04-T09": ["S04-T04", "S04-T05", "S04-T06", "S04-T07", "S04-T08"],
  "S04-T10": ["S04-T09"],
  "S05-T01": ["S04-T10"],
  "S05-T02": ["S05-T01"],
  "S05-T03": ["S05-T01", "S05-T02"],
  "S05-T04": ["S05-T02", "S05-T03"],
  "S05-T05": ["S05-T02", "S05-T03"],
  "S05-T06": ["S05-T02", "S05-T03", "S05-T04", "S05-T05"],
  "S05-T07": ["S05-T02", "S05-T04"],
  "S05-T08": ["S05-T02", "S05-T06"],
  "S05-T09": ["S05-T01", "S05-T02", "S05-T07", "S05-T08"],
  "S05-T10": ["S05-T02", "S05-T08", "S05-T09"],
  "S05-T11": ["S05-T03", "S05-T04", "S05-T05", "S05-T06", "S05-T07", "S05-T08", "S05-T09", "S05-T10"],
  "S06-T01": ["S05-T11"],
  "S06-T02": ["S06-T01"],
  "S06-T03": ["S05-T11"],
  "S06-T04": ["S06-T01", "S06-T03"],
  "S06-T05": ["S06-T01", "S06-T02", "S06-T04"],
  "S06-T06": ["S06-T01", "S06-T03"],
  "S06-T07": ["S06-T01", "S06-T06"],
  "S06-T08": ["S06-T01", "S06-T02", "S06-T03", "S06-T04", "S06-T05", "S06-T06", "S06-T07"],
  "S06-T09": ["S06-T03", "S06-T04", "S06-T05", "S06-T06", "S06-T07", "S06-T08"],
  "S06-T10": ["S06-T05", "S06-T08", "S06-T09"],
}

export const adaptiveTaskKeys: ReadonlySet<string> = new Set(Object.keys(dependencies))

const branchTopics: Readonly<Record<string, string>> = {
  "S01-T01": "schema",
  "S01-T02": "policy",
  "S01-T03": "store",
  "S01-T04": "resolver",
  "S01-T05": "audit",
  "S01-T06": "protocol",
  "S01-T07": "supervisor",
  "S01-T08": "gateway",
  "S01-T09": "controller",
  "S01-T10": "gate",
  "S02-T01": "contracts",
  "S02-T02": "storage",
  "S02-T03": "projector",
  "S02-T04": "render",
  "S02-T05": "assembler",
  "S02-T06": "tools",
  "S02-T07": "loop",
  "S02-T08": "recovery",
  "S02-T09": "gate",
  "S03-T01": "contracts",
  "S03-T02": "validator",
  "S03-T03": "store",
  "S03-T04": "cycle",
  "S03-T05": "roadmap",
  "S03-T06": "discovery",
  "S03-T07": "repomap",
  "S03-T08": "details",
  "S03-T09": "gate",
  "S04-T01": "contracts",
  "S04-T02": "storage",
  "S04-T03": "manifest",
  "S04-T04": "git",
  "S04-T05": "managed",
  "S04-T06": "scheduler",
  "S04-T07": "freeze",
  "S04-T08": "messages",
  "S04-T09": "workers",
  "S04-T10": "gate",
  "S05-T01": "contracts",
  "S05-T02": "evidence",
  "S05-T03": "commands",
  "S05-T04": "validator",
  "S05-T05": "invalidation",
  "S05-T06": "integration",
  "S05-T07": "conflict",
  "S05-T08": "materialize",
  "S05-T09": "api",
  "S05-T10": "operations",
  "S05-T11": "gate",
  "S06-T01": "config",
  "S06-T02": "provider",
  "S06-T03": "secrets",
  "S06-T04": "sandbox",
  "S06-T05": "benchmark",
  "S06-T06": "telemetry",
  "S06-T07": "backup",
  "S06-T08": "chaos",
  "S06-T09": "release",
  "S06-T10": "gate",
}

const gateKeys = new Set(["S01-T10", "S02-T09", "S03-T09", "S04-T10", "S05-T11", "S06-T10"])

function slug(value: string) {
  return value
    .toLowerCase()
    .replace(/`/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
}

function classifyArea(task: DiscoveredTask) {
  const title = task.title.toLowerCase()
  if (task.stage === 4 && /contract|communication/.test(title)) return "area:contracts"
  if (/schema|contract/.test(title)) return "area:schema"
  if (/context|recovery|tool|turn/.test(title)) return "area:context"
  if (/roadmap|coordinator|discovery|repomap|detail/.test(title)) return "area:coordinator"
  if (/workspace|worktree|scheduler|worker/.test(title)) return "area:workspace"
  if (/validator|evidence|acceptance/.test(title)) return "area:validation"
  if (/integration|conflict|materialization/.test(title)) return "area:integration"
  if (/http|api|client|operations|export/.test(title)) return "area:api"
  if (/secret|sandbox|security/.test(title)) return "area:security"
  if (/benchmark|model audit/.test(title)) return "area:benchmark"
  if (/backup|retention|observability|health|load|chaos|soak/.test(title)) return "area:operations"
  if (/release|packag/.test(title)) return "area:release"
  return task.stage <= 2 ? "area:runtime" : "area:core"
}

export async function discoverTasks(plansDirectory: string): Promise<readonly DiscoveredTask[]> {
  const result: DiscoveredTask[] = []
  for (const stage of stageDefinitions) {
    const source = await Bun.file(`${plansDirectory.replace(/\/$/, "")}/${stage.planFile}`).text()
    const lines = source.split("\n")
    const starts = lines.flatMap((line, index) => (/^## Task \d+: /.test(line) ? [index] : []))
    for (let position = 0; position < starts.length; position++) {
      const start = starts[position]!
      const end = starts[position + 1] ?? lines.length
      const match = lines[start]!.match(/^## Task (\d+): (.+)$/)
      if (!match) throw new Error(`Invalid task heading in ${stage.planFile}:${start + 1}`)
      const task = Number(match[1])
      const title = match[2]!
      const section = lines.slice(start, end)
      const filesStart = section.indexOf("**Files:**")
      const stepStart = section.findIndex((line) => line.startsWith("- [ ] **Step 1:"))
      if (filesStart < 0 || stepStart < 0 || stepStart <= filesStart) {
        throw new Error(`Task S${stage.stage}-T${task} is missing Files or Step 1`)
      }
      const files = section
        .slice(filesStart + 1, stepStart)
        .flatMap((line) => Array.from(line.matchAll(/`([^`]+)`/g), (item) => item[1]!))
      result.push({
        key: `S${String(stage.stage).padStart(2, "0")}-T${String(task).padStart(2, "0")}`,
        stage: stage.stage,
        task,
        title,
        planFile: stage.planFile,
        anchor: `task-${task}-${slug(title)}`,
        files,
      })
    }
  }
  return result
}

export function buildTaskSpecs(tasks: readonly DiscoveredTask[]): readonly TaskSpec[] {
  const keys = new Set(tasks.map((task) => task.key))
  if (keys.size !== tasks.length) throw new Error("Duplicate task key")
  if (Object.keys(dependencies).length !== tasks.length) throw new Error("Dependency map does not cover every task")
  return tasks.map((task) => {
    const taskDependencies = dependencies[task.key]
    const topic = branchTopics[task.key]
    const stage = stageDefinitions.find((item) => item.stage === task.stage)
    if (!taskDependencies || !topic || !stage) throw new Error(`Missing management metadata for ${task.key}`)
    for (const dependency of taskDependencies) {
      if (!keys.has(dependency)) throw new Error(`Unknown dependency ${dependency} for ${task.key}`)
    }
    const kind = gateKeys.has(task.key)
      ? "kind:gate"
      : task.stage === 6
        ? "kind:hardening"
        : /fixture|test/i.test(task.title)
          ? "kind:test"
          : "kind:feature"
    return {
      ...task,
      dependencies: taskDependencies,
      labels: [
        "adaptive-runtime",
        `stage:${task.stage}`,
        kind,
        classifyArea(task),
        ...(gateKeys.has(task.key) ? ["user-gate"] : []),
      ],
      branch: `${task.key.toLowerCase()}-${topic}`,
      targetBranch: `stage-${String(task.stage).padStart(2, "0")}`,
      milestone: stage.milestone,
      evidence: stage.evidence,
    }
  })
}

export function renderIssueBody(spec: TaskSpec, issueNumbers: ReadonlyMap<string, number>) {
  const planUrl = `https://github.com/xtt5480446/opencode/blob/main/docs/superpowers/plans/${spec.planFile}#${spec.anchor}`
  const dependencyNumbers = spec.dependencies.map((key) => issueNumbers.get(key))
  if (dependencyNumbers.some((number) => number === undefined)) {
    throw new Error(`Issue number missing for a dependency of ${spec.key}`)
  }
  const dependencyText = dependencyNumbers.length ? dependencyNumbers.map((number) => `#${number}`).join(", ") : "None"
  const files = spec.files.length
    ? spec.files.map((file) => `- \`${file}\``).join("\n")
    : "- See the authoritative plan section."
  return `<!-- adaptive-runtime-task:${spec.key} -->

Plan: [${spec.key} - ${spec.title}](${planUrl})

- Milestone: \`${spec.milestone}\`
- Target branch: \`${spec.targetBranch}\`
- Task branch: \`${spec.branch}\`
- Depends on: ${dependencyText}

## Scope

Implement the complete task section in the linked plan. The plan's schemas, red/green sequence, commands, expected failures, and user-visible behavior are authoritative.

## Files

${files}

## Correctness evidence

${spec.evidence}

## Definition of Done

- [ ] The planned test is written first and observed failing for the intended missing behavior.
- [ ] The complete planned implementation is present without unrelated refactors.
- [ ] Focused tests and typecheck commands from the plan pass.
- [ ] Relevant package and baseline regressions from the plan pass.
- [ ] Generated files and migrations have no drift where applicable.
- [ ] The PR targets \`${spec.targetBranch}\`, links this task, and uses \`Closes this Issue\`.
- [ ] Review findings are resolved and verification evidence is attached.
- [ ] ${tutorialRequirement(spec.key)}
${gateKeys.has(spec.key) ? "- [ ] The user has run the packaged artifact and explicitly accepted the Gate before the stage PR merges to `main`." : ""}
`
}

function tutorialRequirement(key: string) {
  return `The implementation tutorial matching \`docs/adaptive-runtime/tutorials/${key.toLowerCase()}-*.md\` is added, indexed, CI-validated, and reviewed before acceptance.`
}

export function ensureTutorialDoD(body: string, key: string, state: IssueRecord["state"]) {
  if (body.includes(tutorialRequirement(key))) return body
  if (!body.includes("## Definition of Done")) throw new Error(`Issue ${key} is missing Definition of Done`)
  return `${body.trimEnd()}\n- [${state === "closed" ? "x" : " "}] ${tutorialRequirement(key)}\n`
}

export function missingByKey<T>(desired: readonly T[], existing: readonly T[], key: (item: T) => string): readonly T[] {
  const current = new Set(existing.map(key))
  return desired.filter((item) => !current.has(key(item)))
}

export async function reconcileGitHub(client: GitHubBootstrapClient, specs: readonly TaskSpec[]) {
  const labels = await client.listLabels()
  for (const label of missingByKey(desiredLabels, labels as readonly LabelDefinition[], (item) => item.name)) {
    await client.createLabel(label)
  }

  const existingMilestones = await client.listMilestones()
  const milestoneByTitle = new Map(existingMilestones.map((milestone) => [milestone.title, milestone]))
  for (const stage of stageDefinitions) {
    if (milestoneByTitle.has(stage.milestone)) continue
    const milestone = await client.createMilestone({
      title: stage.milestone,
      description: `Adaptive Runtime Stage ${stage.stage} user gate. Estimated duration: ${stage.estimate}.`,
    })
    milestoneByTitle.set(milestone.title, milestone)
  }

  const existingIssues = await client.listIssues()
  const issueByTitle = new Map(existingIssues.map((issue) => [issue.title, issue]))
  const issueNumbers = new Map<string, number>()
  const issueRecords: IssueRecord[] = []
  for (const spec of specs) {
    const title = `[${spec.key}] ${spec.title}`
    let issue = issueByTitle.get(title)
    if (!issue) {
      const milestone = milestoneByTitle.get(spec.milestone)
      if (!milestone) throw new Error(`Milestone ${spec.milestone} is missing`)
      issue = await client.createIssue({
        title,
        body: renderIssueBody(spec, issueNumbers),
        labels: spec.labels,
        milestone: milestone.number,
      })
      issueByTitle.set(title, issue)
    } else {
      const body = ensureTutorialDoD(issue.body, spec.key, issue.state)
      if (body !== issue.body) {
        issue = await client.updateIssue(issue.number, { body })
        issueByTitle.set(title, issue)
      }
    }
    issueNumbers.set(spec.key, issue.number)
    issueRecords.push(issue)
  }

  const existingProject = await client.getProject()
  const project =
    existingProject ??
    (await client.createProject({
      title: projectTitle,
      shortDescription: "Commercial V1 execution board for the 59-task Adaptive Runtime program.",
      readme:
        "Stages are sequential through G1-G6; eligible tasks run in controlled parallel worktrees. Issues are authoritative work items and PRs target stage branches.",
    }))
  if (existingProject) {
    await client.updateProject(project.id, {
      shortDescription: "Commercial V1 execution board for the 59-task Adaptive Runtime program.",
      readme:
        "Stages are sequential through G1-G6; eligible tasks run in controlled parallel worktrees. Issues are authoritative work items and PRs target stage branches.",
    })
  }
  const currentItems = await client.listProjectIssueNumbers(project.id)
  const missingItems = issueRecords.filter((issue) => !currentItems.has(issue.number))
  if (missingItems.length) await client.addProjectItems(project.id, missingItems)

  return { project, issueNumbers }
}

export function renderGitHubIndex(
  specs: readonly TaskSpec[],
  issueNumbers: ReadonlyMap<string, number>,
  project: ProjectRecord,
) {
  const rows = specs.map((spec) => {
    const number = issueNumbers.get(spec.key)
    if (!number) throw new Error(`Issue number missing for ${spec.key}`)
    const dependencyLinks = spec.dependencies
      .map((key) => {
        const dependency = issueNumbers.get(key)
        if (!dependency) throw new Error(`Issue number missing for dependency ${key}`)
        return `#${dependency}`
      })
      .join(", ")
    return [
      spec.key,
      `[#${number}](https://github.com/xtt5480446/opencode/issues/${number})`,
      spec.milestone,
      spec.title.replace(/\|/g, "\\|"),
      `\`${spec.targetBranch}\``,
      dependencyLinks || "None",
    ]
  })
  const headers = ["Task", "Issue", "Milestone", "Title", "Target", "Dependencies"]
  const widths = headers.map((header, index) => Math.max(header.length, ...rows.map((row) => row[index]!.length)))
  const line = (cells: readonly string[]) =>
    `| ${cells
      .map((cell, index) => (index === 1 ? cell.padStart(widths[index]!) : cell.padEnd(widths[index]!)))
      .join(" | ")} |`
  const separator = widths.map((width, index) => (index === 1 ? `${"-".repeat(width - 1)}:` : "-".repeat(width)))
  return `# Adaptive Runtime GitHub Task Index

Generated by \`script/adaptive-github-bootstrap.ts\`. GitHub Issues and the linked implementation plans are authoritative.

Project: ${project.url}

${line(headers)}
${line(separator)}
${rows.map(line).join("\n")}
`
}
