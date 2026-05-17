# Effect Service Dependency Graph — Simulated Routes

Generated for `createSimulatedRoutes` in `packages/opencode/src/server/routes/instance/httpapi/server.ts`.

## Notation

- `→ X` means "yields `X.Service` from its `Effect.gen` body at layer init (a true `RIn` of `.layer`)"
- `(lazy)` means "uses `InstanceState.context` or similar at call time, not at layer construction"
- `(opt)` means "uses `Effect.serviceOption(X)` — not strictly required"
- `(internal)` means "satisfied internally by the `.layer` itself via `Layer.provide(...)`, NOT a residual requirement"

## Service → Dependencies (current, post-rebase)

```
─── External / Platform ─────────────────────────────────────────
NodePath                   (no app deps)            provides Path.Path
FetchHttpClient            (no app deps)            provides HttpClient.HttpClient
HttpServer.layerServices   (no app deps)
ChildProcessSpawner        (from SimulationSpawner) (no app deps)

─── Leaf services (no app deps) ─────────────────────────────────
Global                     (no app deps)
Env                        (no app deps — uses InstanceState.make, no Service yields)
Bus                        (no app deps — uses InstanceState.make, no Service yields)
SyncEvent                  → RuntimeFlags, Bus  (NEW — previously listed as leaf/lazy)
AccountRepo                (no app deps — pure DB closures)
PtyTicket                  (no app deps — Cache only)
Truncate                   → AppFileSystem

─── Middleware/route layers (no app service deps) ───────────────
errorLayer
compressionLayer           → HttpServerRequest (builtin)
corsVaryFix
fenceLayer                 → HttpServerRequest (builtin)
simulationShareNextLayer   provides ShareNext (Layer.succeed override)

─── Simulation overrides ────────────────────────────────────────
SimulationFileSystem       provides AppFileSystem (does NOT provide FileSystem.FileSystem;
                           tier0 also merges FileSystem.layerNoop({}) for that tag)
SimulationSpawner          provides ChildProcessSpawner (Layer.succeed; no deps)
SimulationNetwork          provides SimulationNetwork.Service + HttpClient.HttpClient
                           (httpClientLayer composed inside `layer(options)`)
SimulationGit              → AppFileSystem               (overrides Git tag)
SimulationProvider         → Simulation                  (overrides Provider tag)
Simulation                 → AppFileSystem, SimulationNetwork

─── Core services ───────────────────────────────────────────────
EffectFlock                → Global, AppFileSystem
Auth                       → AppFileSystem
McpAuth                    → AppFileSystem
Account                    → AccountRepo, HttpClient
Npm                        → AppFileSystem, Global, FileSystem.FileSystem, EffectFlock
Config                     → AppFileSystem, Auth, Account, Env, Npm
Permission                 → Bus
Plugin                     → Bus, Config, RuntimeFlags                       (NEW: RuntimeFlags)
Discovery                  → AppFileSystem, Path, HttpClient
Skill                      → Discovery, Config, Bus, AppFileSystem, Global,
                              RuntimeFlags                                    (NEW: RuntimeFlags)
SystemPrompt               → Skill

─── File / git ──────────────────────────────────────────────────
Ripgrep                    → AppFileSystem, HttpClient, ChildProcessSpawner
File                       → AppFileSystem, Ripgrep, Git, Scope
FileWatcher                → Config, Git
Format                     → Config, AppProcess, RuntimeFlags                 (CHANGED: was ChildProcessSpawner; now AppProcess + RuntimeFlags)
Snapshot                   → AppFileSystem, AppProcess, Config                (CHANGED: was ChildProcessSpawner)
Storage                    → AppFileSystem, Git
Vcs                        → Git, Bus, Scope
Worktree                   → Scope, AppFileSystem, Path, AppProcess,
                              Git, Project, InstanceStore                     (CHANGED: AppProcess instead of ChildProcessSpawner)
Project                    → AppFileSystem, Path, ChildProcessSpawner,
                              Bus, RuntimeFlags                               (NEW: RuntimeFlags)

─── Provider / LSP / MCP ────────────────────────────────────────
ModelsDev                  → AppFileSystem, HttpClient
ProviderAuth               → Auth, Plugin
LSP                        → Config, RuntimeFlags                             (NEW: RuntimeFlags)
McpAuth                    → AppFileSystem
MCP                        → ChildProcessSpawner, McpAuth, Bus, Config

─── Session graph ───────────────────────────────────────────────
Todo                       → Bus
Question                   → Bus
SessionStatus              → Bus
SessionRunState            → BackgroundJob, SessionStatus                     (NEW: BackgroundJob)
Instruction                → Config, AppFileSystem, Global, HttpClient,
                              RuntimeFlags                                    (NEW: RuntimeFlags)

Session                    → BackgroundJob, Bus, Storage, SyncEvent,
                              RuntimeFlags                                    (NEW: BackgroundJob, RuntimeFlags)
SessionSummary             → Session, Snapshot, Storage, Bus

SessionRevert              → Session, Snapshot, Storage, Bus,
                              SessionSummary, SessionRunState, SyncEvent
LLM                        → Auth, Config, Provider, Plugin, RuntimeFlags     (CHANGED: Permission satisfied internally;
                              (Permission satisfied internally via .layer)     RuntimeFlags is new)

Agent                      → Config, Auth, Plugin, Skill, Provider,
                              RuntimeFlags                                    (NEW: RuntimeFlags)
Command                    → Config, MCP, Skill

SessionProcessor           → Session, Config, Bus, Snapshot, Agent, LLM,
                              Permission, Plugin, SessionSummary,
                              SessionStatus, Image, EventV2Bridge,
                              RuntimeFlags, Scope                             (NEW: Image, EventV2Bridge, RuntimeFlags)
SessionCompaction          → Bus, Config, Session, Agent, Plugin,
                              SessionProcessor, Provider, EventV2Bridge,
                              RuntimeFlags                                    (NEW: EventV2Bridge, RuntimeFlags)
SessionPrompt              → Bus, SessionStatus, Session, Agent, Provider,
                              SessionProcessor, SessionCompaction, Plugin,
                              Command, Config, Permission, AppFileSystem,
                              MCP, LSP, ToolRegistry, Truncate,
                              ChildProcessSpawner, Scope, Instruction,
                              SessionRunState, SessionRevert,
                              SessionSummary, SystemPrompt, LLM,
                              Image, Reference, EventV2Bridge,
                              RuntimeFlags                                    (NEW: Image, Reference, EventV2Bridge, RuntimeFlags)

ToolRegistry               → Config, Plugin, Question, Todo, Agent, Skill,
                              Session, SessionStatus, BackgroundJob,
                              Provider, Git, Reference, LSP, Instruction,
                              AppFileSystem, Bus, HttpClient,
                              ChildProcessSpawner, Ripgrep, Format,
                              Truncate, RuntimeFlags                          (NEW: BackgroundJob, Reference, RuntimeFlags)

─── Share / Workspace ───────────────────────────────────────────
ShareNext                  (provided by simulationShareNextLayer in sim)
SessionShare               → Config, Session, ShareNext, Scope, SyncEvent,
                              RuntimeFlags                                    (NEW: RuntimeFlags)
Workspace                  → Auth, Session, SessionPrompt, HttpClient,
                              SyncEvent, Vcs, AppFileSystem, RuntimeFlags    (NEW: AppFileSystem (explicit), RuntimeFlags)

─── Misc ────────────────────────────────────────────────────────
Installation               → HttpClient, AppProcess                           (CHANGED: AppProcess instead of ChildProcessSpawner)
Pty                        → Config, Bus, Plugin

─── Instance lifecycle ──────────────────────────────────────────
InstanceBootstrap          → Config, File, FileWatcher, Format, LSP, Plugin,
                              Project, Reference, ShareNext, Snapshot, Vcs   (NEW: Reference)
InstanceStore              → Project, InstanceBootstrap, Scope

Observability              (no app deps; provides Logger + tracer)
```

## NEW dependencies introduced since previous graph

The rebase pulled in several new cross-cutting services that need to be
satisfied somewhere in tier0/tier1 of the simulated chain. They are NOT yet
listed in the `Tier*Services` unions or merged into any tier in `server.ts`:

```
RuntimeFlags.Service        — yielded by ~17 services (Plugin, Skill, Project,
                              Session, SyncEvent, Format, LSP, Instruction,
                              Agent, LLM, SessionShare, SessionProcessor,
                              SessionCompaction, ToolRegistry, SessionPrompt,
                              Workspace, SessionRunState).
                              Source: `@/effect/runtime-flags`.

AppProcess.Service          — yielded by Installation, Format, Snapshot,
                              Worktree (and prod Git, but sim uses SimulationGit).
                              Source: presumed `@opencode-ai/core/app-process`
                              or similar — needs `AppProcess.defaultLayer`.

BackgroundJob.Service       — yielded by Session, SessionRunState, ToolRegistry.
                              Needs `BackgroundJob.defaultLayer`.

Image.Service               — yielded by SessionProcessor, SessionPrompt.

EventV2Bridge.Service       — yielded by SessionProcessor, SessionCompaction,
                              SessionPrompt. Source: `@/event-v2-bridge` (already
                              imported in server.ts but never added to a tier).

Reference.Service           — yielded by ToolRegistry, SessionPrompt,
                              InstanceBootstrap.
```

## Dependency Tiers (topological order)

Roughly, build order from leaves to roots:

```
Tier 0 (no deps):
  Global, Env, NodePath, AccountRepo, PtyTicket, Bus, SyncEvent,
  AppFileSystem (sim), ChildProcessSpawner (sim), HttpClient (sim),
  SimulationNetwork, FileSystem.layerNoop, simulationShareNextLayer
  + (NEW REQUIRED) RuntimeFlags, AppProcess, BackgroundJob, Image,
                   EventV2Bridge, Reference
  (SyncEvent now depends on RuntimeFlags + Bus, so it's actually tier 1.)

Tier 1:
  Auth, Truncate, EffectFlock, Permission, Todo, Question,
  SessionStatus, McpAuth, Discovery, SimulationGit, Ripgrep, Account,
  SyncEvent (needs RuntimeFlags + Bus)

Tier 2:
  Npm, ModelsDev, Project, Installation, Storage, Vcs, SessionRunState

Tier 3:
  Config, File, Simulation, Session

Tier 4:
  Plugin, FileWatcher, Format, Snapshot, LSP, MCP, Skill, Instruction,
  SimulationProvider (= Provider)

Tier 5:
  Pty, ProviderAuth, SessionSummary, Agent, Command, LLM, SystemPrompt

Tier 6:
  SessionRevert, SessionProcessor, SessionShare

Tier 7:
  SessionCompaction, ToolRegistry

Tier 8:
  SessionPrompt

Tier 9:
  Workspace, InstanceBootstrap

Tier 10:
  InstanceStore

Tier 11:
  Worktree
```

## Potential cycles / hazards

```
Worktree → InstanceStore → InstanceBootstrap → Project → (back to Worktree?)
  - InstanceBootstrap requires Project (yes)
  - Project does NOT require Worktree directly
  - Worktree requires InstanceStore at layer init
  → Worktree must be built AFTER InstanceStore.

SimulationProvider provides Provider tag, depends on Simulation.
  Many downstream services depend on Provider — those resolve to
  SimulationProvider in this layer chain.

SimulationGit provides Git tag, used by File, FileWatcher,
  Storage, Vcs, Worktree, ToolRegistry tools.

LLM.layer pipes Layer.provide(Permission.defaultLayer) internally.
  So LLM's residual requirements no longer include Permission, BUT the
  sim chain still provides Permission.layer separately (correct — used by
  SessionProcessor, SessionPrompt directly).
```

## Why the simulated chain fails today

The current `server.ts` `Tier0Services` union lists:
```
AppFileSystem, FileSystem.FileSystem, ChildProcessSpawner, HttpClient,
SimulationNetwork, Path, Global, Env, Bus, AccountRepo, ShareNext,
SyncEvent, PtyTicket
```

But the actual `Layer.mergeAll(...)` body at tier0 has residual requirements
beyond that union. The TS error says
`Layer<..., never, Service | Service>` — those two unresolved `Service`s
are members of the NEW dependencies table above.

The most likely culprits, in order of leakage:

1. **`SyncEvent.layer`** now yields `RuntimeFlags` and `Bus`. `Bus` is in tier0
   already, but `RuntimeFlags` is not provided anywhere in `createSimulatedRoutes`.
   So `SyncEvent` leaks `RuntimeFlags` into tier0's `RIn`.

2. Downstream tiers also leak `RuntimeFlags`, `AppProcess`, `BackgroundJob`,
   `Image`, `EventV2Bridge`, `Reference` — these cascade through every higher
   tier as `Service | Service | ...` in the error type.

## Fix strategy

The minimal change to make tier0 type-check:

1. Add `RuntimeFlags.defaultLayer` to tier0 and `RuntimeFlags.Service` to
   `Tier0Services`. This satisfies `SyncEvent`'s new dep and unblocks every
   service that yields `RuntimeFlags`.
2. Add `AppProcess.defaultLayer` (or a simulated equivalent) to tier0 and
   `AppProcess.Service` to `Tier0Services`. Needed by `Installation`, `Format`,
   `Snapshot`, `Worktree`.
3. Add `BackgroundJob.defaultLayer` to tier0 and `BackgroundJob.Service` to
   `Tier0Services`. Needed by `Session`, `SessionRunState`, `ToolRegistry`.
4. Add `Image.defaultLayer` to tier0 (or wherever it fits) and `Image.Service`
   to `Tier0Services`. Needed by `SessionProcessor`, `SessionPrompt`.
5. Add `EventV2Bridge.defaultLayer` to tier0 and `EventV2Bridge.Service` to
   `Tier0Services`. (Note: `EventV2Bridge` is already imported in `server.ts`
   for the production routes but is not in any simulated tier.)
6. Add `Reference.defaultLayer` to a tier that satisfies its deps (it's a leaf
   wrt the listed graph above) and `Reference.Service` to the corresponding
   tier union. Needed by `ToolRegistry`, `SessionPrompt`, `InstanceBootstrap`.

Production routes (`createProductionRoutes`) already include
`RuntimeFlags.defaultLayer` and `EventV2Bridge.defaultLayer` in the flat
`Layer.provide([...])` list — they were simply never carried over to the
simulated chain after the rebase.

## See also

- `dependency-graph.html` — interactive visualization of the same data.
