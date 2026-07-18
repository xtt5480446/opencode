# Adaptive Runtime Tutorial Enforcement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make one substantive implementation tutorial a visible and merge-blocking deliverable for every Adaptive Runtime Sxx-Txx task.

**Architecture:** A pure Bun validator checks trusted PR event metadata, Git name-status changes, tutorial structure, and the tutorial index. Existing GitHub bootstrap code renders and incrementally reconciles task-specific DoD entries, while a separate idempotent ruleset reconciler activates merge protection after the trusted default-branch workflow has exercised a stage PR.

**Tech Stack:** TypeScript, Bun test, GitHub Actions, GitHub REST API through the existing `gh` runner, Markdown.

---

## File map

- Create `docs/adaptive-runtime/tutorials/TEMPLATE.md`: canonical learner-facing tutorial structure and author instructions.
- Create `script/adaptive-tutorial-check.ts`: pure validation plus trusted `pull_request_target` event adapter.
- Create `script/adaptive-tutorial-check.test.ts`: validator, PR template, tutorial template, and workflow safety tests.
- Create `.github/workflows/adaptive-tutorial.yml`: required stage-PR check executed from the trusted default-branch workflow commit.
- Modify `.github/pull_request_template.md`: visible Adaptive Task/Tutorial fields and completion checkbox.
- Modify `script/adaptive-github-bootstrap-lib.ts`: Tutorial DoD rendering and incremental existing-Issue reconciliation.
- Modify `script/adaptive-github-bootstrap-api.ts`: Issue state decoding and body-only Issue update API.
- Modify `script/adaptive-github-bootstrap.test.ts`: RED/GREEN coverage for new/existing/closed Issue behavior and REST payloads.
- Create `script/adaptive-tutorial-ruleset.ts`: desired `stage-*` ruleset and idempotent GitHub adapter.
- Create `script/adaptive-tutorial-ruleset.test.ts`: ruleset create/update/no-op and exact policy tests.

### Task 1: Canonical tutorial template and pure PR validation

**Files:**

- Create: `docs/adaptive-runtime/tutorials/TEMPLATE.md`
- Create: `script/adaptive-tutorial-check.ts`
- Create: `script/adaptive-tutorial-check.test.ts`

- [ ] **Step 1: Write failing validator tests**

Define test fixtures with these exact required headings:

```ts
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
```

Add tests asserting:

```ts
expect(validateAdaptiveTutorial(nonStageInput())).toEqual([])
expect(validateAdaptiveTutorial(validStageInput())).toEqual([])
expect(validateAdaptiveTutorial({ ...validStageInput(), baseRef: "stage-02" })).toContain(
  "Task S01-T03 does not belong to base branch stage-02.",
)
expect(validateAdaptiveTutorial({ ...validStageInput(), body: "" })).toEqual(
  expect.arrayContaining([
    "PR body must declare Adaptive Runtime Task as Sxx-Txx.",
    "PR body must declare one canonical Adaptive Runtime Tutorial path.",
    "Adaptive Runtime tutorial confirmation is not checked.",
  ]),
)
```

Cover wrong path/prefix, tutorial status `M` instead of `A`, two new files for the same prefix, README not changed, missing index link, missing/out-of-order/short section, retained `<!-- tutorial:` marker, unchecked confirmation, and `tutorial-exempt` label bypass.

- [ ] **Step 2: Run the focused test and observe the missing module**

Run:

```bash
cd script
bun test adaptive-tutorial-check.test.ts
```

Expected: FAIL because `adaptive-tutorial-check.ts` does not exist.

- [ ] **Step 3: Implement the pure validator**

Export these types and functions:

```ts
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

export async function validateAdaptiveTutorial(input: ValidationInput): Promise<readonly string[]>
```

Parse visible PR lines in this exact form:

```text
Adaptive Runtime Task: `S01-T03`
Adaptive Runtime Tutorial: `docs/adaptive-runtime/tutorials/s01-t03-foundation-store.md`
- [x] I added and indexed the required Adaptive Runtime implementation tutorial.
```

Accept tutorial paths only when they match:

```ts
;/^docs\/adaptive-runtime\/tutorials\/(s\d{2}-t\d{2})-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/
```

For each required heading, find its line index, require strictly increasing order, and require at least 40 letters/numbers/CJK characters before the next required heading. Return all failures in stable validation order. Return immediately for a non-`stage-NN` base or when `tutorial-exempt` is present.

- [ ] **Step 4: Write the canonical Tutorial template**

Create a Chinese template using the nine exact headings. Under every heading include an author-only marker such as:

```markdown
<!-- tutorial:replace-this-guidance -->
```

Each marker tells the author what evidence belongs in that section. Include a risk/test/proof table under “测试看护逻辑”, runnable commands plus expected observations under “亲手验证”, and instructions to remove every `<!-- tutorial:` marker before opening the PR.

- [ ] **Step 5: Run the focused test**

Run:

```bash
cd script
bun test adaptive-tutorial-check.test.ts
```

Expected: all Task 1 tests pass.

### Task 2: Trusted workflow adapter and PR checklist

**Files:**

- Modify: `script/adaptive-tutorial-check.ts`
- Modify: `script/adaptive-tutorial-check.test.ts`
- Create: `.github/workflows/adaptive-tutorial.yml`
- Modify: `.github/pull_request_template.md`

- [ ] **Step 1: Add failing repository-contract tests**

Read the PR template and workflow as text and assert:

```ts
expect(prTemplate).toContain("### Adaptive Runtime implementation tutorial")
expect(prTemplate).toContain("Adaptive Runtime Task: `N/A`")
expect(prTemplate).toContain("Adaptive Runtime Tutorial: `N/A`")
expect(prTemplate).toContain("I added and indexed the required Adaptive Runtime implementation tutorial.")

expect(workflow).toContain("pull_request_target:")
expect(workflow).toContain('branches: ["stage-*"]')
expect(workflow).toContain("contents: read")
expect(workflow).not.toContain("pull-requests: write")
expect(workflow).toContain("working-directory: script")
expect(workflow).toContain("bun test adaptive-tutorial-check.test.ts")
expect(workflow).toContain("bun script/adaptive-tutorial-check.ts")
```

Add adapter tests with a temporary Git repository or injected command/read functions so a synthetic event produces the same `ValidationInput` as the pure tests. Verify the adapter reads files with `git show <headSha>:<path>` and never checks out or executes head code.

- [ ] **Step 2: Run focused tests and observe the missing workflow/template fields**

Run:

```bash
cd script
bun test adaptive-tutorial-check.test.ts
```

Expected: repository-contract and adapter tests fail for the intended missing behavior.

- [ ] **Step 3: Implement the trusted event adapter**

When `import.meta.main`, read `GITHUB_EVENT_PATH`, validate base/head values as full hexadecimal Git SHAs, obtain changes using:

```text
git diff --name-status <baseSha> <headSha>
```

Read PR-head Markdown without checking it out:

```text
git show <headSha>:<path>
```

Print every validation failure prefixed by `- ` and exit `1`; print the validated task/path or non-stage/exemption reason and exit `0` otherwise.

- [ ] **Step 4: Add the PR template fields**

Append before the general checklist:

```markdown
### Adaptive Runtime implementation tutorial

_Required for Sxx-Txx PRs targeting `stage-*`; ordinary OpenCode PRs leave both fields as `N/A`._

Adaptive Runtime Task: `N/A`
Adaptive Runtime Tutorial: `N/A`

- [ ] I added and indexed the required Adaptive Runtime implementation tutorial.
```

- [ ] **Step 5: Add the trusted workflow**

Use `pull_request_target` for `stage-*` and events `opened`, `reopened`, `synchronize`, `edited`, `labeled`, and `unlabeled`. Grant only `contents: read`. Checkout `github.workflow_sha` with full history, fetch the PR head as data, set up Bun from that trusted workflow revision, run the focused validator test, then run the trusted validator against `GITHUB_EVENT_PATH`. Name the job `adaptive-tutorial` so the ruleset context is stable.

- [ ] **Step 6: Run focused tests and a local fail/pass event pair**

Run:

```bash
cd script
bun test adaptive-tutorial-check.test.ts
```

Then create event JSON under a temporary directory and run the CLI once with missing PR fields (expected exit `1`) and once with a complete tutorial/index fixture commit (expected exit `0`). Do not add temporary fixtures to the repository.

### Task 3: Tutorial DoD rendering and incremental Issue sync

**Files:**

- Modify: `script/adaptive-github-bootstrap-lib.ts`
- Modify: `script/adaptive-github-bootstrap-api.ts`
- Modify: `script/adaptive-github-bootstrap.test.ts`

- [ ] **Step 1: Add failing new/existing Issue tests**

Extend the rendered body test with:

```ts
expect(body).toContain(
  "The implementation tutorial matching `docs/adaptive-runtime/tutorials/s01-t02-*.md` is added, indexed, CI-validated, and reviewed before acceptance.",
)
```

Add focused tests for:

```ts
expect(ensureTutorialDoD(existingOpenBody, "S01-T03", "open")).toContain("- [ ] The implementation tutorial")
expect(ensureTutorialDoD(existingClosedBody, "S01-T02", "closed")).toContain("- [x] The implementation tutorial")
expect(ensureTutorialDoD(alreadyUpdatedBody, "S01-T03", "open")).toBe(alreadyUpdatedBody)
expect(ensureTutorialDoD(existingOpenBody, "S01-T03", "open")).toContain("- [x] Existing completed item")
```

Extend reconciliation mocks to assert existing Issue bodies are updated exactly once and the second reconciliation is a no-op for Issue bodies.

- [ ] **Step 2: Run bootstrap tests and observe missing update behavior**

Run:

```bash
cd script
bun test adaptive-github-bootstrap.test.ts
```

Expected: FAIL because `ensureTutorialDoD`, Issue state, and `updateIssue` do not exist.

- [ ] **Step 3: Implement incremental DoD reconciliation**

Add `state: "open" | "closed"` to `IssueRecord`, an `updateIssue(number, { body })` client method, and this exported helper:

```ts
export function ensureTutorialDoD(body: string, key: string, state: IssueRecord["state"]) {
  if (body.includes("The implementation tutorial matching `docs/adaptive-runtime/tutorials/")) return body
  if (!body.includes("## Definition of Done")) throw new Error(`Issue ${key} is missing Definition of Done`)
  const checked = state === "closed" ? "x" : " "
  return `${body.trimEnd()}\n- [${checked}] ${tutorialRequirement(key)}\n`
}
```

Use the same `tutorialRequirement(key)` inside `renderIssueBody`. During reconciliation, preserve the existing Issue body, call `updateIssue` only when the helper changes it, and update the in-memory record before project reconciliation.

- [ ] **Step 4: Implement REST Issue update**

Decode `state` from list/create/update responses. Update bodies through:

```text
PATCH repos/xtt5480446/opencode/issues/<number>
```

using `{ body }` only, so labels, milestone, title, assignees, and checklist state are not replaced.

- [ ] **Step 5: Add the controlled exemption label**

Append to `desiredLabels`:

```ts
{
  name: "tutorial-exempt",
  color: "D93F0B",
  description: "Maintainer-approved non-task stage PR without a new implementation tutorial",
}
```

- [ ] **Step 6: Run bootstrap tests**

Run:

```bash
cd script
bun test adaptive-github-bootstrap.test.ts
```

Expected: all bootstrap, API adapter, retry, idempotency, and 59-task tests pass.

### Task 4: Idempotent `stage-*` ruleset management

**Files:**

- Create: `script/adaptive-tutorial-ruleset.ts`
- Create: `script/adaptive-tutorial-ruleset.test.ts`

- [ ] **Step 1: Write failing desired-policy and reconciliation tests**

Test that `desiredRuleset` has:

```ts
{
  name: "adaptive-stage-tutorial",
  target: "branch",
  enforcement: "active",
  conditions: { ref_name: { include: ["refs/heads/stage-*"], exclude: [] } },
}
```

Assert it contains a pull-request rule and a required-status-check rule for context `adaptive-tutorial`, strict policy enabled, and `do_not_enforce_on_create: true`. Mock list/create/update operations and verify absent creates once, identical is a no-op, and drifted policy updates once.

- [ ] **Step 2: Run the focused test and observe the missing module**

Run:

```bash
cd script
bun test adaptive-tutorial-ruleset.test.ts
```

Expected: FAIL because the ruleset module does not exist.

- [ ] **Step 3: Implement ruleset reconciliation and CLI**

Export an injectable interface:

```ts
export interface RulesetClient {
  readonly list: () => Promise<readonly RulesetRecord[]>
  readonly create: (input: DesiredRuleset) => Promise<void>
  readonly update: (id: number, input: DesiredRuleset) => Promise<void>
}

export async function reconcileRuleset(client: RulesetClient): Promise<"created" | "updated" | "unchanged">
```

The `gh` adapter uses `GET /repos/xtt5480446/opencode/rulesets`, `POST` to create, and `PUT /repos/xtt5480446/opencode/rulesets/<id>` to update. Compare normalized rule/condition JSON, ignoring API response-only fields. The CLI prints the resulting action.

- [ ] **Step 4: Run focused ruleset tests**

Run:

```bash
cd script
bun test adaptive-tutorial-ruleset.test.ts
```

Expected: all policy and idempotency tests pass without calling GitHub.

### Task 5: Full local verification and management PR

**Files:**

- Verify all files in the file map.

- [ ] **Step 1: Install the locked workspace**

Run:

```bash
/home/xtt/.cache/bun/1.3.14/bun-linux-x64/bun install --frozen-lockfile
```

Expected: Bun 1.3.14 installs without changing `bun.lock`.

- [ ] **Step 2: Run all focused enforcement tests**

Run:

```bash
cd script
bun test adaptive-tutorial-check.test.ts adaptive-tutorial-ruleset.test.ts adaptive-github-bootstrap.test.ts
```

Expected: zero failures.

- [ ] **Step 3: Verify formatting, workflow, and type safety**

Run Prettier over all changed Markdown/TypeScript/YAML, `git diff --check`, and root `bun typecheck`. Parse the workflow as YAML through an installed structured parser or GitHub-compatible action linter; do not validate YAML with string indentation guesses alone.

- [ ] **Step 4: Review the exact diff and commits**

Confirm the branch changes only management docs, tutorial enforcement scripts/tests, PR template, workflow, and bootstrap code. No baseline runtime package may change. Commit in focused slices, then push `tutorial-enforce` and create a conventional `chore: enforce adaptive implementation tutorials` PR targeting `main`.

- [ ] **Step 5: Merge the management PR after checks**

Resolve all review/CI findings, rerun Step 2/3, merge without force-push, and update local `main` from `origin/main`.

### Task 6: Stage synchronization, live Issue sync, and required check

**Files:**

- Synchronize the merged enforcement files to `stage-01`.
- Synchronize the already reviewed T01/T02 tutorial backfill into `stage-01`.

- [ ] **Step 1: Exercise the trusted live workflow**

After the management PR merges to `main`, open a temporary stage PR with missing Adaptive fields and verify `adaptive-tutorial` fails with all expected diagnostics. Update the same PR with a complete synthetic tutorial/index and verify it passes. Close the temporary PR without merging fixture content.

- [ ] **Step 2: Activate and inspect the repository ruleset**

Run:

```bash
bun script/adaptive-tutorial-ruleset.ts
```

Expected: first run prints `created` or `updated`; second run prints `unchanged`. Read the live ruleset through `gh api` and verify the `stage-*` pattern and required `adaptive-tutorial` context.

- [ ] **Step 3: Synchronize enforcement sources and tutorials to stage**

Create a short branch from current `stage-01`, apply the merged management changes and the T01/T02 backfill, correct the S01-T01 wording to say OpenCode Agent execution configuration is reusable but not sufficient as Adaptive durable lifecycle, and run the focused enforcement/T01/T02 tests. Create a non-task synchronization PR targeting `stage-01` with the maintainer-controlled `tutorial-exempt` label, verify the required check passes through that explicit exemption, and merge it.

- [ ] **Step 4: Synchronize all Task DoD entries**

Run the tested `adaptive-github-bootstrap.ts` from the merged management revision. Inspect Issues #1, #2, #3, and one issue from every later Stage. Verify #1/#2 have a checked Tutorial item, #3-#59 have an unchecked item, and all existing body/checklist content remains present.

- [ ] **Step 5: Reconcile S01-T03 branch and verify enforcement**

Merge updated `stage-01` into the preserved `s01-t03-store` branch, resolve any identical tutorial add/add conflict without dropping the T03 design commit, add the S01-T03 Tutorial path/README entry before opening its PR, and run the same validator locally. Only then resume S01-T03 product TDD.
