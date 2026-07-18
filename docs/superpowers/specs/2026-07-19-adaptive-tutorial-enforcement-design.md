# Adaptive Runtime Tutorial Enforcement Design

## 1. Goal

Every Adaptive Runtime development task must ship a learner-facing Chinese implementation tutorial in the same task PR. The requirement must be visible before work starts, actionable while the PR is written, mechanically verified by CI, and merge-blocking on every `stage-*` integration branch.

The mechanism applies to S01-T01 through S06-T10 without changing baseline OpenCode product behavior or imposing tutorial requirements on ordinary PRs targeting `main`/`dev`.

## 2. Tutorial contract

`docs/adaptive-runtime/tutorials/TEMPLATE.md` is the canonical authoring contract. A completed tutorial uses Chinese for explanation and keeps code identifiers, APIs, commands, SQL, and standard technical names in English. It must independently explain:

- the task outcome and its role in the current Milestone and final short-context Agent goal;
- the relevant OpenCode baseline call path and the exact reuse/non-reuse boundary;
- final requirements, invariants, implementation, data/control flow, and recommended code-reading order;
- plain-language definitions of the task's professional terms and patterns;
- a risk-to-test matrix, what the tests prove, what they do not prove, runnable commands, and expected observations;
- current limitations and downstream task dependencies.

The filename is `docs/adaptive-runtime/tutorials/<lowercase-task-key>-<descriptive-slug>.md`. CI accepts exactly one newly added file matching the task prefix, for example `s01-t03-*.md`, and requires the tutorial index to link that exact filename.

## 3. Task and PR visibility

The centralized `adaptive-github-bootstrap` renderer adds a task-specific Tutorial checkbox to every generated Issue Definition of Done. Reconciliation inserts the same checkbox into existing Issue bodies without rewriting checked boxes or other user-maintained content. Closed historical tasks receive a checked Tutorial item; open tasks receive an unchecked item.

The default PR template adds an Adaptive Runtime section with visible Task ID and Tutorial path fields plus a completion checkbox. PRs targeting ordinary branches may leave these fields as `N/A`; PRs targeting `stage-*` may not self-declare `N/A`.

## 4. CI validator

A small repository script owns validation logic and is covered by focused unit tests. It parses Markdown into structural tokens so HTML comments, fenced/inline code, and other non-visible source text cannot impersonate PR fields, checklist items, index links, headings, or tutorial prose. The `pull_request_target` workflow checks out `github.workflow_sha`, so the validator and setup action always come from the trusted default-branch revision that triggered the run; it fetches the PR head only as Git data and never executes it. For a PR whose base matches `stage-NN`, it verifies:

1. the PR body contains exactly one visible `Sxx-Txx` Task ID and one visible canonical tutorial path;
2. the Task belongs to the canonical 59-task program and its stage equals the base branch stage;
3. the declared tutorial is newly added in the PR and is the only new tutorial with that Task prefix;
4. `docs/adaptive-runtime/tutorials/README.md` changed and contains a real relative link to the declared file;
5. all required level-two headings exist in order, every section has substantive Chinese prose outside code/comments, and no template marker remains;
6. the Adaptive Runtime PR checkbox is checked.

PRs not targeting `stage-*` pass without an Adaptive tutorial. A non-task maintenance PR targeting a stage branch may bypass the tutorial only when a maintainer applies the `tutorial-exempt` label; writing `N/A` in the body is insufficient. The validator reports every violation in one run so the author can repair the PR without repeated CI cycles.

The workflow runs on PR open, reopen, synchronize, edit, label, and unlabel events. It executes the validator's focused tests before validating the live PR event.

## 5. Merge enforcement and bootstrap order

A CI result alone is advisory because `stage-01` currently has no branch protection. Completion therefore includes an active repository ruleset matching `stage-*` that:

- requires PR-based changes;
- requires the `adaptive-tutorial` status check;
- permits creation of a new stage branch before its first check exists;
- does not provide a PR-body-only bypass.

GitHub reads the automatic PR template and `pull_request_target` workflow from the default branch. Bootstrap therefore uses this order:

1. land the management files and PR template on `main`;
2. run the trusted workflow against a stage PR and activate the `stage-*` ruleset with `adaptive-tutorial` required;
3. synchronize the enforcement sources and reviewed tutorial backfill into `stage-01` for source continuity;
4. update all 59 Issue bodies through the tested bootstrap reconciler;
5. confirm a deliberately incomplete fixture/event fails and a complete one passes before S01-T03 resumes.

The trusted default-branch workflow covers every future stage branch through its `stage-*` event filter and the same ruleset pattern. Enforcement sources are also synchronized into stage history so accepted stage commits remain self-describing.

Ruleset comparison ignores GitHub response metadata but preserves every rule type and non-null status-check `integration_id`. This makes repeated runs no-ops while extra rules, wrong check bindings, and other policy drift are repaired.

## 6. Verification

Automated tests cover non-stage bypass, malformed/missing/hidden/duplicate PR fields, plan-unknown Task IDs, stage mismatch, wrong or duplicate tutorial files, modified instead of newly added tutorial, fake or missing index links, hidden/missing/out-of-order/empty/English-only sections, unchanged template markers, unchecked PR confirmation, and maintainer-label exemption.

Bootstrap tests prove that the DoD line is rendered for new tasks, inserted exactly once for existing tasks, preserves existing body/checklist state, and updates GitHub only when needed. API adapter tests cover Issue update payloads.

Repository verification includes focused script tests, Prettier, workflow syntax parsing, a local synthetic PR event for both fail/pass paths, exact diff review, and inspection of the live Issue bodies, workflow check, and ruleset after landing.

## 7. Non-goals

- Judging tutorial prose quality with an LLM in CI.
- Requiring tutorials for non-Adaptive baseline PRs.
- Treating the tutorial as a replacement for design specs, implementation plans, code review, or user acceptance.
- Allowing CI success to substitute for the user reading and running large-feature acceptance steps.
