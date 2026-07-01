# Opencode Simulation Architecture

Status: first milestone architecture draft.

## Goal

Build a simulation environment for exploring opencode through the real app, primarily through the TUI, while replacing only the lowest foundational layers needed to make runs controlled, observable, and safe.

The first milestone is an interactive exploration and model-based testing environment. It should be enough to start opencode normally, put the app into generated states, drive real user-level TUI actions, observe what happened, and record an in-memory trace that can later be exported into deterministic replay tests.

This is not intended to be a custom simulated app or a separate `simulate` command. The normal app should run, with simulation enabled by one required flag:

```sh
OPENCODE_SIMULATION=1 bun run dev
```

## Non-Goals

- Do not reimplement the app.
- Do not replace mid-level services like session processing, tool registry, provider orchestration, route trees, or TUI components unless a foundational seam proves impossible.
- Do not build shrinking in the first milestone.
- Do not make generated randomized runs part of CI yet.
- Do not build differential testing in the first milestone.
- Do not expose simulation controls when `OPENCODE_SIMULATION` is not set.

## Design Principles

- Run the real app through normal commands.
- Drive the TUI using real user-level input: typing, keypresses, focus, click, and mouse actions.
- Keep simulation code isolated under a simulation/testing area.
- Touch production app code only at narrow activation points: builders, TUI startup, foundational layers, and simulation-gated backend routes.
- Swap foundational layers, not app logic.
- Make observations rich enough for humans and models.
- Treat traces as first-class artifacts.
- Use a lightweight model of expected high-level behavior, not a clone of opencode internals.
- Generate valid commands from current observed state rather than blindly fuzzing impossible actions.

## Activation

`OPENCODE_SIMULATION=1` is the only required flag.

Optional flags can be added later, but should stay minimal. Reasonable optional parameters later include renderer mode, trace output path, seed, or port override.

When enabled:

- The app builds with simulation layer replacements.
- The TUI process starts a loopback WebSocket control server.
- Simulation-gated backend control routes become available only to the frontend/control path.
- In-memory trace recording starts automatically.

## Control Server

The external control surface lives in the TUI/frontend process, not the backend API server.

This is important because the frontend has direct access to the renderer, screen state, focus state, interactable elements, and user input APIs. The backend remains the normal backend, with only simulation-gated control routes used internally by the frontend when needed.

Protocol:

- JSON-RPC 2.0 over WebSocket.
- Loopback only.
- Start at `127.0.0.1:40900`.
- If occupied, scan upward and report the actual URL.
- External drivers connect only to this frontend WebSocket.

The app should not send JSON-RPC requests back to the driver in the first milestone. The driver sends requests; the app responds and emits notifications/events as useful.

Initial method groups:

- `ui.state`: return screen, elements, focus, and generated possible actions.
- `ui.action`: execute one real user-level action.
- `ui.render`: force or wait for a render and return state.
- `backend.filesystem.seed`: seed project files.
- `backend.filesystem.write`: write one file.
- `backend.network.register`: register a fake network response.
- `backend.llm.enqueue`: queue scripted LLM behavior.
- `backend.snapshot`: return backend simulation state.
- `trace.list`: return trace records.
- `trace.clear`: clear in-memory trace.
- `trace.export`: export trace JSON for replay/test generation.
- `run.stabilize`: wait for frontend/backend quiescence and return observations.

## TUI Actions

The old simulation branch had the right basic shape: observe OpenTUI renderables, derive executable actions, and execute those actions through OpenTUI input/mouse APIs.

The first action vocabulary should stay close to that work:

```ts
type UIAction =
  | { type: "typeText"; text: string }
  | { type: "pressKey"; key: string; modifiers?: KeyModifiers }
  | { type: "pressEnter" }
  | { type: "pressArrow"; direction: "up" | "down" | "left" | "right" }
  | { type: "focus"; target: number }
  | { type: "click"; target: number; x: number; y: number }
```

`ui.state` should return:

- Current screen text.
- Focused renderable/editor state.
- Interactable elements.
- Generated actions valid for the current UI state.

Elements should include stable-enough semantic data where available:

- Renderable ID and numeric target.
- Position and dimensions.
- Focusable/clickable/editor flags.
- Focused flag.
- Text or label when available.
- Role/capability when available.

Both fake OpenTUI renderer and visible terminal renderer should share this protocol. The architecture should support both; the default can be decided later.

## Backend Control

The backend server should be exactly the normal backend server.

Simulation-only backend routes may exist, but only when `OPENCODE_SIMULATION=1`. They are private implementation details for the frontend simulation server to proxy commands like filesystem seeding, LLM scripting, network registration, and snapshots.

External drivers should not use backend simulation routes directly.

## Foundational Layer Replacement

Current `origin/dev` has the right seam: `AppNodeBuilder.build(...)` and `AppNodeBuilderV1.build(...)` accept replacements over `LayerNode`s. Simulation should use those seams instead of adding large alternate app assemblies.

First milestone replacements:

- Filesystem.
- Network / HTTP client.
- LLM boundary.
- Process spawner.

First milestone generated state surfaces:

- Filesystem/project state.
- Network responses.
- LLM scripts.
- Process registry behavior.
- Plugin-generated config state.

Likely later replacements:

- Clock/random.
- Database path/isolation.
- Global paths/temp paths.

The goal is to swap things at the bottom of the app. Everything above these foundational services should behave as production code.

## Filesystem

The first filesystem simulation should be temp-directory backed.

Rationale:

- It is easier to inspect while debugging.
- It avoids reimplementing all filesystem semantics immediately.
- It makes generated scenarios concrete and replayable.
- It keeps the path open to tool behavior that expects real files.

The temp filesystem is still controlled and isolated:

- Each run gets its own temp root.
- Project files, config, data, state, cache, and temp paths should resolve inside that root.
- Host filesystem escapes should fail loudly.
- Trace should record seeded files and file diffs/observations needed for replay.

## Configuration Via Generated Plugins

Generated configuration is a core first-milestone feature.

Much of opencode behavior is driven by config. The simulation runner needs to put the app into many different config-shaped states: different agents, tools, providers, MCP servers, permissions, modes, instructions, formatting settings, feature flags, and other config-dependent behavior.

The runner should not primarily generate arbitrary config files. Instead, the simulation should express config-shaped state as generated plugins.

Rationale:

- Plugins are already a normal extension surface for opencode behavior.
- Generated plugins can produce app states without making the simulation depend on config-file syntax and file layout details.
- Plugin-generated state keeps setup closer to runtime behavior: the app reads config, loads plugins, and observes plugin-provided behavior through normal app paths.
- Plugins are a better unit for model-based generation because they can be named, versioned, traced, reused, and minimized independently.

The first implementation should support generated simulation plugins that can contribute or affect config-equivalent domains such as:

- Agents and agent defaults.
- Provider/model availability.
- Tool definitions and tool behavior.
- MCP-like capabilities or endpoints.
- Permission defaults and policies.
- Instructions/system-context-like inputs where supported.
- Formatting/project behavior where supported.
- Workspace/project adapters where supported.

The simulation can still write the minimal bootstrap state needed for opencode to discover generated plugins, but the interesting generated state should live in plugin definitions rather than large generated `opencode.json` files.

Trace should record:

- Generated plugin IDs.
- Plugin-provided config/state fragments.
- Plugin hooks registered.
- Any plugin load/config errors.
- Which generated plugin state was active for each run.

The model-based runner should include commands for generating and enabling plugin state. These commands should have normal preconditions and postconditions just like UI actions or backend setup commands.

Example command families:

- Generate a provider/model plugin.
- Generate an agent configuration plugin.
- Generate a tool plugin with scripted behavior.
- Generate permission policy state.
- Generate MCP-like tool/resource state.
- Enable or disable a generated plugin for the next app run.

This is the main mechanism for exploring app states driven by configuration.

## Network

Unknown external network should fail loudly by default.

The simulation network should support explicit response registration:

- JSON response.
- Text response.
- Bytes response later if needed.
- Status-only response.
- Handler-style response later if needed.

Loopback traffic needed by the app/frontend/backend may be allowed explicitly.

All network calls should be traceable:

- Method.
- URL.
- Request headers/body where safe.
- Matched simulation route.
- Status.
- Response summary.
- Error if denied.

## LLM

The LLM boundary should be scriptable.

The driver can enqueue scripts that describe model behavior:

- Text chunks.
- Thinking/reasoning chunks if relevant.
- Tool calls.
- Errors.
- Finish reason.

The real session and tool pipeline should consume this behavior through the normal app path. The simulation should not bypass `SessionPrompt`, `SessionProcessor`, or tool execution.

Missing scripted LLM behavior should fail with a clear simulation error unless a default response is explicitly configured.

## Process Spawning

External process spawning should be denied by default.

The first milestone should provide a simulated process registry. This should be inspired by the old branch:

- Shell commands can run through `just-bash` against the simulated filesystem.
- A small fake `git` command set can support project discovery/status paths needed by the app.
- Unsupported process spawns fail loudly.

This preserves the rule that simulation does not spawn arbitrary external programs while still allowing useful shell/tool flows.

## Trace

Trace recording is always on in simulation mode, in memory for the first milestone.

Trace entries should be append-only JSON-compatible records. They do not need to be written to disk initially, but `trace.export` should return a structure suitable for later replay and test generation.

Trace should include:

- Run metadata: seed, app version, renderer mode, WebSocket URL.
- Initial world setup.
- UI observations.
- Generated UI actions.
- Executed UI actions.
- Backend control requests.
- Backend snapshots.
- Network requests and matches/denials.
- LLM scripts enqueued and consumed.
- Tool calls and results.
- Permission decisions.
- Filesystem seed/write/diff summaries.
- Generated plugin/config state and load results.
- Stabilization boundaries.
- Errors and crashes.
- Model command execution and postcondition results.

The trace is the bridge between exploratory simulation and deterministic tests.

## Model-Based Runner

The first runner is an external driver connecting to the frontend WebSocket.

Use a custom runner for now, not `fast-check`. It should still follow the core shape used by property/model-based testing libraries:

```ts
interface Command<Model> {
  readonly name: string
  check(model: Model): boolean
  run(model: Model, app: SimulationClient): Promise<void>
}
```

Basic runner responsibilities:

- Keep a lightweight model of high-level expected state.
- Generate commands whose preconditions match the model and current app observations.
- Execute commands through the WebSocket.
- Update the model.
- Check postconditions/invariants.
- Record all steps in the trace.
- Support seed/replay.
- Track simple distribution stats.

The model should track high-level, observational state only, such as:

- Current screen/route category.
- Whether prompt editor is available.
- Known sessions.
- Known files and expected file contents/diffs.
- Queued LLM scripts.
- Recent backend/session status.
- Whether app is expected to be idle.

The model must not track implementation internals like fibers, exact runner loop state, cache internals, or database implementation details.

Initial command families:

- Seed filesystem.
- Generate and enable plugin config state.
- Register network response.
- Enqueue LLM script.
- Observe UI state.
- Execute one generated UI action.
- Type prompt text.
- Press enter.
- Stabilize.
- Assert no crash.
- Assert visible response or file effect.
- Export trace.

## Generators

The first milestone should include generation, but not shrinking.

Generation should be model-based and state-aware:

- Generate from currently valid `ui.state.actions`.
- Generate backend setup commands from scenario/model state.
- Generate plugin-provided config state.
- Generate LLM scripts that match likely user prompts and tool flows.
- Generate short command sequences using preconditions.
- Use a seed so runs can be replayed.
- Use simple weights to avoid degenerate action selection.

The generator should not attempt to produce arbitrary full app states upfront. It should build state by executing commands through the real app and observing the result.

Important stats to record:

- Seed.
- Command counts.
- Action type distribution.
- Generated plugin/config domain distribution.
- Rejected command/precondition counts.
- UI element/action coverage.
- Backend event type coverage where available.
- Errors and stabilization failures.

## Properties

First milestone properties should be simple and high-signal:

- App does not crash.
- Backend does not crash.
- Unknown network is denied.
- Host filesystem escape is denied.
- Prompt submission can reach a scripted LLM response.
- Stabilization eventually reaches a coherent idle state for the demo flow.
- File effects from scripted tool behavior are observable in the simulated filesystem.
- Trace contains enough information to replay the run.

More advanced model/refinement, metamorphic, and differential properties are future work.

## First Demo Flow

The first major demo should show this system as a real environment for exploring the app in controlled states:

1. Start opencode normally with `OPENCODE_SIMULATION=1`.
2. TUI starts and exposes the simulation WebSocket on `127.0.0.1:40900+`.
3. External runner connects.
4. Runner seeds a temp-backed project filesystem.
5. Runner generates and enables plugin-provided config state.
6. Runner queues a scripted LLM response.
7. Runner observes `ui.state` and generated actions.
8. Runner drives real TUI input to type and submit a prompt.
9. App processes the prompt through the real backend/session/tool path.
10. Scripted LLM response appears or executes a file-affecting tool flow.
11. Runner stabilizes the app.
12. Runner inspects trace, backend snapshot, UI state, generated plugin state, and filesystem state.
13. Runner exports a deterministic replay trace.

## Done-When Checklist

- `OPENCODE_SIMULATION=1` starts the normal app with simulation wiring.
- Simulation code is isolated under a dedicated simulation/testing area.
- App changes outside simulation are limited to activation hooks, builder replacements, TUI startup, and gated backend routes.
- TUI exposes JSON-RPC WebSocket on `127.0.0.1:40900+`.
- Driver can call `ui.state`.
- Driver can execute generated UI actions.
- Fake and visible renderer paths use the same action protocol.
- Driver can seed filesystem state.
- Driver can generate and enable plugin-provided config state.
- Driver can register network responses and observe denied unknown network.
- Driver can enqueue LLM scripts.
- External process spawning is denied by default, with shell via `just-bash` and minimal fake process registry support.
- Driver can run a basic model-based generated command sequence.
- In-memory trace records observations/actions/backend interactions.
- Driver can list, clear, and export trace.
- Demo flow succeeds end-to-end.

## Future Directions

- Shrinking failed traces.
- Promote minimized traces into normal committed tests.
- Coverage-guided corpus and structured trace mutation.
- Richer semantic UI grounding for model-driven exploration.
- LLM-generated property proposals with validity/soundness checks.
- Differential testing across app versions, renderers, or storage modes.
- Deterministic scheduler/clock/random control.
- Parallel campaigns with isolated workers.
- File-backed trace persistence and replay CLI.
