# S01-T02 Immutable ModelPolicy Hashing Design

## 1. Goal and boundary

S01-T02 adds the Core-owned deterministic operations for the `AdaptiveTask.ModelPolicy` contract created by S01-T01. It creates a policy hash from every execution-affecting field and rejects policy drift or hash tampering before later persistence and model-execution layers rely on that identity.

This task does not resolve model names, choose context limits, persist policy records, run models, or change baseline OpenCode Session, Agent, Model, or provider behavior.

## 2. Public API

`@opencode-ai/core/adaptive/model-policy` exports one `AdaptiveModelPolicy` namespace with:

- `Input`: `AdaptiveTask.ModelPolicy` without `hash`.
- `create(input)`: returns a schema-validated `AdaptiveTask.ModelPolicy` with a canonical SHA-256 hash.
- `assertEqual(expected, actual)`: returns only when both policies have valid derived hashes and identical execution fields; otherwise it throws `Adaptive ModelPolicy mismatch`.

No mutable policy builder or hash override is exposed.

## 3. Canonical representation

The hash input is compact JSON with this exact ordered projection:

1. `providerID`
2. `modelID`
3. `variant`, omitted when undefined
4. `effectiveContextLimit`
5. `outputReserve`
6. `safetyReserve`

The implementation constructs this object explicitly instead of hashing the caller object or using a generic recursive stable-stringify helper. This makes the audit boundary readable, ignores irrelevant runtime properties, and guarantees that caller key insertion order cannot affect the hash.

The final value is `sha256:` plus the lowercase hexadecimal result from OpenCode's existing `Hash.sha256()` utility. S01-T02 does not add another cryptographic implementation.

## 4. Integrity and equality

`assertEqual` checks all of the following:

- the expected hash equals a fresh hash of the expected canonical fields;
- the actual hash equals a fresh hash of the actual canonical fields;
- the two stored hashes are equal;
- the two canonical strings are equal.

The canonical comparison is retained even though SHA-256 collisions are impractical: ModelPolicy equality is a business invariant, not merely a probabilistic hash lookup. Recomputing both hashes also rejects two identically tampered policy records.

## 5. Data flow and consumers

```text
S01-T04 model resolution
  -> AdaptiveModelPolicy.create(input)
  -> S01-T03 persists the complete policy
  -> S01-T05/S01-T08 compare persisted and requested policy
  -> assertEqual recomputes both hashes before model execution
```

S01-T02 depends only on `@opencode-ai/schema/adaptive-task` and Core's existing `Hash.sha256`. It has no dependency on the legacy Session loop or on future Adaptive Runtime services.

## 6. Verification

Tests must cover:

- a fixed known SHA-256 vector for the canonical JSON representation;
- caller key reordering producing the same hash;
- omitted and explicitly undefined `variant` producing the same hash;
- each of the six execution-affecting fields independently changing the hash;
- S01-T01 budget validation still being enforced by `create`;
- equal policies being accepted;
- field drift, a reused old hash, a changed hash, and two identically tampered policies being rejected;
- focused Core tests, full Core tests, Core typecheck, Prettier, exact file-boundary checks, and the repository pre-push typecheck.

## 7. Non-goals

- Generic canonical JSON serialization.
- Credential, prompt, ContextManifest, or tool-policy hashing.
- Database immutability and migration logic.
- Model resolution or provider calls.
- HTTP, SDK, CLI, or generated schema changes.
