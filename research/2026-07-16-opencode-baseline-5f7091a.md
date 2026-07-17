# OpenCode Baseline and Architecture Audit

Date: 2026-07-16

## 1. Scope

This report establishes a reproducible OpenCode baseline before designing the short-context Agent. It answers three narrower questions:

1. Can the selected OpenCode revision be built and run reproducibly?
2. How does the current standard `opencode run` path construct, grow, compact, and persist context?
3. What do two real autonomous runs reveal about baseline quality and context cost?

It does **not** yet establish the target 256k-versus-1M result. No paid provider credentials are configured, so both runs used `opencode/deepseek-v4-flash-free`, whose advertised context limit is 200k.

## 2. Reproducible Artifact

| Item | Value |
| --- | --- |
| Upstream revision | `5f7091ab4e261cca5383cbd57aa6aa589ed9ee86` |
| Pristine checkout | `.opencode-baseline-5f7091a` |
| Frozen source archive | `.opencode-5f7091a.tar.gz` |
| Declared Bun version | `1.3.14` |
| Baseline package version | `0.0.0-baseline-5f7091a` |
| Linux x64 binary | `.opencode-baseline-5f7091a/packages/opencode/dist/opencode-linux-x64/bin/opencode` |
| Binary size | approximately 171 MB |
| Binary SHA-256 | `53d748353f84833710f9a0c6dc6d131fc1f239fbbd7858d7663c0a24e19faf51` |

Development and packaged servers both passed `/global/health`. Package type checking passed. The generated OpenAPI document contained 162 paths and 472 schemas.

Runs used isolated `HOME` and `XDG_*` directories plus disabled auto-update, sharing, model fetching, and channel-specific databases. The CLI was invoked with an explicit model and JSON event output. Session exports, database counters, logs, and source inspection were used as evidence.

## 3. Experimental Results

### 3.1 Architecture Investigation

The task asked OpenCode to investigate its own execution architecture. The main Agent created two explore child sessions.

| Session | Model turns | Maximum turn context | Sum of processed turn tokens | Tool calls | Tool output characters |
| --- | ---: | ---: | ---: | ---: | ---: |
| Main | 7 | 99,445 | 430,933 | 25 | 299,616 |
| Explore child 1 | 7 | 41,690 | 179,373 | 27 | 102,236 |
| Explore child 2 | 14 | 100,769 | 779,848 | 65 | 285,464 |
| **Total** | **28** | - | **1,390,154** | **117** | **687,316** |

Wall time was approximately 218 seconds. No session compacted.

The final report contained a material architectural error: it presented the V2 `SessionV2`/`SessionRunner` path as the standard CLI path. Source tracing shows that standard non-interactive `opencode run` calls the SDK's `client.session.prompt`, whose `/session/{sessionID}/message` handler invokes legacy `SessionPrompt.prompt`. V2 is a parallel `/api/session/*` surface.

This is a useful baseline failure: the model read both implementations but did not preserve the entrypoint distinction.

### 3.2 Coding Task: Large Export Truncation

The task was to diagnose and fix large `opencode export` output truncation in a disposable checkout.

Observed root cause:

- `ExportCommand` issued fire-and-forget `process.stdout.write` calls.
- The top-level CLI unconditionally called `process.exit()` in `finally`.
- When stdout was a pipe, queued bytes were terminated before flushing.

The Agent changed the two writes to await their callbacks through `Effect.promise`. Independent end-to-end verification against the same stored session produced:

| Implementation | Bytes emitted | Valid JSON | Messages |
| --- | ---: | --- | ---: |
| Frozen baseline binary | 65,536 | No, unterminated string | Not parseable |
| Patched source CLI | 597,244 | Yes | 8 |

Independent verification also found:

- focused tests: 2 passed;
- CLI test directory: 368 passed, 5 skipped, 0 failed;
- package typecheck: passed.

The implementation works, but the new test is not a valid regression test. It constructs a generic `Writable`, duplicates the callback pattern, and never imports or invokes `ExportCommand` or the CLI. It would pass with the old production implementation unchanged, contrary to the repository rule to test the actual implementation rather than duplicate logic.

Task cost:

| Session | Model turns | Maximum turn context | Sum of processed turn tokens |
| --- | ---: | ---: | ---: |
| Main coding session | 25 | 57,908 | 1,056,688 |
| Explore child used to find one type signature | 4 | 11,559 | 39,455 |
| **Total** | **29** | - | **1,096,143** |

The main session lasted 258.3 seconds and did not compact. The child session spent 39,455 processed tokens to answer a narrow API-signature question. The main Agent still mislabeled its copied-pattern test as a regression test.

Baseline verdict for this task: **functional fix, incomplete autonomous verification**.

## 4. Standard Run Architecture

### 4.1 Actual Entry Path

The standard path is:

```text
opencode run
  -> client.session.prompt(...)
  -> POST /session/{sessionID}/message
  -> SessionHttpApi.prompt
  -> SessionPrompt.prompt
  -> SessionPrompt.loop / runLoop
  -> SessionProcessor + LLM
```

Evidence:

- `packages/opencode/src/cli/cmd/run.ts:859`
- `packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts:295`
- `packages/opencode/src/session/prompt.ts:1053`

V2 instead records a durable `session_input`, wakes `SessionExecution`, and runs a location-scoped `SessionRunner`. Its `SessionContextEpoch` is a stronger basis for stable system context and restartable input admission, but it is not the execution path measured above.

### 4.2 Context Assembly

On every legacy provider turn, the loop:

1. reloads the session transcript from SQLite;
2. applies compaction filtering, if a completed compaction exists;
3. applies session reminders;
4. resolves the complete tool set;
5. lets plugins mutate the message array;
6. adds environment, repository instructions, MCP instructions, and skills;
7. converts the remaining transcript into model messages.

There is no task-aware historical selector. Before compaction, every retained prior turn is replayed. This explains the growing turn totals in both experiments.

Static code access is demand-driven through read, grep, glob, LSP, and shell tools. Large tool output is truncated at 50 KiB or 2,000 lines by default and written to a temporary detail file. This is a useful local detail mechanism, but it is not a dependency-aware project memory.

### 4.3 Compaction

Legacy compaction is threshold-driven rather than task- or dependency-driven:

- overflow is decided from the model's reported limits and prior turn token usage;
- the default recent tail is two user turns;
- the preserved recent budget is 2k-8k tokens, normally 25% of usable context;
- older history is summarized by a dedicated compaction Agent;
- prior summaries are anchored into the next summary;
- compaction strips media and limits each tool output to 2,000 characters;
- older tool outputs beyond protected thresholds are marked compacted and replaced with `[Old tool result content cleared]` in future model requests.

The original transcript and tool result remain in SQLite; the model-facing projection is lossy. Compaction therefore controls size but does not create typed project knowledge, dependency contracts, or independently verifiable decisions.

### 4.4 Task Subagents

The built-in task tool creates a child session with `parentID`, derives a restricted permission set, and prompts the child with only the task prompt resolved into parts. It does not automatically inject the parent's transcript, a global project skeleton, dependency contracts, or a shared roadmap.

By default, child sessions are denied `todowrite` and nested `task` unless the selected subagent explicitly allows them. The parent receives the child's final text as a tool result. This is intentionally a constrained delegated tool, not the independent restartable Worker process required by the research proposal.

### 4.5 Persistence and Recovery

SQLite persists sessions, messages, parts, todos, token counters, parent-child links, and newer V2 durable events/inputs. Legacy active runners and background-job registries are instance-local in-memory maps. A later invocation can reload the transcript and continue, but it does not restore an in-flight Worker lifecycle or reconstruct an explicit global task state.

V2 improves the substrate with durable prompt admission, `steer`/`queue` delivery, context epochs, and a session runner. Even V2 still builds a chronological model request from selected session history and compacts on size; it does not implement the proposed roadmap/detail-pool protocol.

## 5. Extension Boundary

OpenCode plugins can:

- add custom tools;
- mutate user messages, model messages, and system prompts;
- observe or alter tool inputs and outputs;
- inject context into or replace the compaction prompt;
- observe session events.

That is enough for an instrumentation prototype and possibly a first roadmap/detail-retrieval experiment. It is not enough for the full architecture because plugins do not own session scheduling, task child construction, durable Worker lifecycle, conflict pausing, or acceptance gates.

Current evidence therefore supports this boundary:

- **Reuse:** provider adapters, tools, permissions, repository instruction discovery, event stream, SQLite schema concepts, and parts of V2 execution/input admission.
- **Modify or wrap at core level:** context selection, roadmap state machine, Worker launch/resume protocol, dependency-aware detail loading, structured result merge, risk escalation, and verification gates.

This is an architectural observation, not yet a final implementation choice.

## 6. Implications for the Research Hypothesis

The experiments support three narrower claims:

1. More available context does not guarantee correct architectural attention. A 100k turn still confused the active legacy path with a parallel V2 path.
2. Chronological transcript replay creates substantial repeated processing before context capacity is exhausted. The two tasks processed 1.39M and 1.10M turn tokens without any compaction.
3. Delegation without shared structured state can be expensive and semantically weak. A narrow signature lookup created a fresh 39.5k-token child session, while the parent still owned all integration and validation reasoning.

They do **not** yet prove that a 256k structured Agent beats a 1M baseline. That requires controlled tasks, matched models or model-quality controls, multiple repositories, and success metrics that separate code correctness from token cost.

## 7. Remaining Evidence Gaps

1. Configure the intended Kimi, DeepSeek, and Opus providers; current credentials count is zero.
2. Select a small but representative task set containing cross-module dependency changes and long-horizon continuation.
3. Capture pass/fail using repository-native tests plus hidden or independently authored acceptance checks.
4. Measure per-turn effective context, total processed tokens, tool-output volume, wall time, rework, compactions, and factual architecture errors.
5. Repeat the frozen OpenCode baseline before introducing any roadmap mechanism.

