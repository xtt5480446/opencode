# Lightweight Adaptive CI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep fork pull requests executable without Blacksmith while making only focused Adaptive Runtime checks block daily stage-task development.

**Architecture:** Stage PRs run one Ubuntu job covering Adaptive contracts, persistence migrations, and Core typechecking. The upstream full unit and cross-platform e2e matrices remain available for `dev` pushes and explicit `workflow_dispatch`, but do not block Adaptive task PRs; fork-only secret jobs skip themselves.

**Tech Stack:** GitHub Actions, Bun, Turbo, TypeScript.

---

### Task 1: Encode the lightweight CI contract

**Files:**

- Modify: `script/github-runner-policy.test.ts`
- Modify: `.github/workflows/test.yml`
- Modify: `.github/workflows/pr-management.yml`

- [ ] **Step 1: Replace the existing runner assertions with a failing contract**

Assert that stage pull requests are accepted, the focused PR job uses `ubuntu-24.04`, full unit/e2e jobs exclude pull requests, all explicit runners are GitHub-hosted, and duplicate detection skips forks.

- [ ] **Step 2: Run the contract test and verify it fails**

Run: `cd script && bun test github-runner-policy.test.ts`

Expected: FAIL because full matrix jobs still run on pull requests and no focused Adaptive job exists.

- [ ] **Step 3: Implement the workflow boundary**

Add a focused `adaptive` PR job for Adaptive schema/Core tests, migration tests, and Core typecheck. Guard full `unit` and `e2e` jobs with `github.event_name != 'pull_request'`; retain hosted Linux/Windows labels for manual/full runs and the fork guard in `pr-management.yml`.

- [ ] **Step 4: Remove hosted-runner test workarounds outside CI policy**

Restore the baseline Core test command and concurrent CLI timing test. Remove the uncommitted Ripgrep extraction experiment and its test.

- [ ] **Step 5: Verify locally and publish**

Run the runner contract, management script suite, focused Adaptive command, repository typecheck, formatter check, YAML parse, and `git diff --check`; then commit, push, and merge PR #68 after its applicable checks pass.

### Task 2: Validate with S01-T03

**Files:**

- Sync the merged CI commit into `stage-01` through a `tutorial-exempt` maintenance PR.
- Continue implementation in `s01-t03-store` using `docs/superpowers/specs/2026-07-18-s01-t03-adaptive-store-design.md`.

- [ ] **Step 1: Merge the CI maintenance sync into `stage-01`**

Expected: the tutorial gate accepts the maintainer-applied `tutorial-exempt` label.

- [ ] **Step 2: Merge updated `stage-01` into `s01-t03-store`**

Expected: the task branch contains the exact workflow revision it will exercise.

- [ ] **Step 3: Implement and locally verify S01-T03**

Follow the approved four slices: schema/migration, Task store, Agent lease CAS, Manifest/Request persistence and restart recovery. Each slice uses red-green tests and an atomic commit.

- [ ] **Step 4: Open the real S01-T03 PR**

Target `stage-01`, link Issue #3, add and index the Chinese implementation tutorial, and provide local verification evidence.

- [ ] **Step 5: Verify the complete PR path**

Expected: focused Adaptive CI passes on Ubuntu, `adaptive-tutorial` passes without exemption, full cross-platform jobs do not run on the task PR, and the user can run the documented file-backed restart acceptance command.
