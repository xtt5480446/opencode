# V2 Config Review

This document breaks the legacy configuration schema into small review groups. Work through one group at a time and decide whether each field should be ported as-is, removed, or redesigned for v2.

## Status Labels

- `pending`: not discussed yet
- `keep`: port with substantially the existing meaning
- `remove`: do not carry forward
- `redesign`: keep the capability with a different shape, scope, or owning module

## Schema Scope

Use one v2 config schema for now. Some fields, such as `autoupdate`, are intended for global/user configuration, but there is not yet enough benefit to enforce that with separate global and location schemas. Revisit this if more scope-sensitive fields survive the review.

## Group 1: File Metadata

Small fields describing the config file itself rather than application behavior.

| Field     | Current Purpose                                            | Status | Notes                                                                                 |
| --------- | ---------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------- |
| `$schema` | JSON schema reference for editor validation and completion | keep   | Keep as read-only metadata; loading config must not insert it or create files for it. |

## Group 2: Process And Server Settings

Settings that affect process startup, shell execution, or network serving. Review global-only versus location-specific scope carefully.

| Field        | Current Purpose                                     | Status | Notes                                                                          |
| ------------ | --------------------------------------------------- | ------ | ------------------------------------------------------------------------------ |
| `shell`      | Default shell for terminal and shell tool execution | keep   | Port as effective config; shared shell choice is used throughout opencode.     |
| `logLevel`   | Intended logging level configuration                | remove | Do not port: no config consumer exists and logging initializes from CLI input. |
| `server`     | Hostname, port, mDNS, and CORS settings             | remove | Do not port: location config is loaded after the server is already running.    |
| `autoupdate` | Automatic update or notification behavior           | keep   | Global-only user preference; keep `true`, `false`, and `"notify"`.             |

## Group 3: Commands And Project Resources

Configuration that introduces location-scoped project resources or discoverable content.

| Field          | Current Purpose                         | Status  | Notes |
| -------------- | --------------------------------------- | ------- | ----- |
| `command`      | User-defined commands                   | pending |       |
| `skills`       | Additional skill locations              | pending |       |
| `reference`    | Named git or local directory references | pending |       |
| `instructions` | Additional instruction file patterns    | pending |       |

## Group 4: Plugins

Plugin loading has source-path and scope-sensitive behavior, so it should be reviewed separately from other project resources.

| Field    | Current Purpose               | Status  | Notes                                                  |
| -------- | ----------------------------- | ------- | ------------------------------------------------------ |
| `plugin` | User-specified plugin modules | pending | Existing loader records origin and global/local scope. |

## Group 5: Filesystem And Tool Runtime

Settings controlling local file observation, snapshots, language tooling, and tool output behavior.

| Field         | Current Purpose                         | Status  | Notes |
| ------------- | --------------------------------------- | ------- | ----- |
| `watcher`     | Ignore patterns for filesystem watching | pending |       |
| `snapshot`    | Enable filesystem snapshot tracking     | pending |       |
| `formatter`   | Configure formatters                    | pending |       |
| `lsp`         | Configure language servers              | pending |       |
| `attachment`  | Configure attachment/image processing   | pending |       |
| `tool_output` | Configure tool output truncation limits | pending |       |

## Group 6: Sharing And Identity

Settings affecting sharing behavior or user/account identity rather than model execution.

| Field        | Current Purpose                                 | Status  | Notes                           |
| ------------ | ----------------------------------------------- | ------- | ------------------------------- |
| `share`      | Session sharing behavior                        | pending |                                 |
| `autoshare`  | Legacy automatic sharing flag                   | pending | Deprecated in favor of `share`. |
| `enterprise` | Enterprise URL configuration                    | pending |                                 |
| `username`   | Display username in conversations and telemetry | pending |                                 |

## Group 7: Providers And Model Selection

Provider catalog customization and model-choice configuration. The new core work has started here.

| Field                | Current Purpose                                   | Status   | Notes                                                                                   |
| -------------------- | ------------------------------------------------- | -------- | --------------------------------------------------------------------------------------- |
| `provider`           | Custom provider configuration and model overrides | pending  | New core schema currently uses `providers`; decide public key compatibility.            |
| `disabled_providers` | Disable automatically loaded providers            | redesign | Replace with `experimental.policies: [{ effect: "deny", action: "provider.use", resource: "..." }]`. |
| `enabled_providers`  | Restrict enabled providers to an allowlist        | redesign | Replace with ordered `provider.use` allow/deny statements and wildcard resources.       |
| `model`              | Default model selection                           | pending  |                                                                                         |
| `small_model`        | Small/utility model selection                     | pending  |                                                                                         |

Provider selection rules belong in `experimental.policies` rather than provider entries or repeated top-level provider fields. Initial proposed shape:

```jsonc
{
  "experimental": {
    "policies": [
      {
        "effect": "deny",
        "action": "provider.use",
        "resource": "*",
      },
      {
        "effect": "allow",
        "action": "provider.use",
        "resource": "anthropic",
      },
    ],
  },
}
```

See [provider-policy.md](./provider-policy.md) for the provider policy semantics and precedence rules.

Policy evaluation will consume authored config documents in reverse order while preserving statement order inside each document. The precedence of `.opencode` policy sources remains open until `.opencode` configuration is reviewed.

## Group 8: Agents And Permissions

Agent behavior and tool-access policy. Review together because agent configuration can contain permissions and model choices.

| Field           | Current Purpose                                     | Status  | Notes                                       |
| --------------- | --------------------------------------------------- | ------- | ------------------------------------------- |
| `default_agent` | Choose default primary agent                        | pending |                                             |
| `mode`          | Legacy agent configuration alias                    | pending | Deprecated in favor of `agent`.             |
| `agent`         | Configure primary, subagent, and specialized agents | pending |                                             |
| `permission`    | Tool permission rules                               | pending |                                             |
| `tools`         | Legacy tool enable/disable map                      | pending | Converted to permissions by current loader. |

## Group 9: Integrations

External protocol and server integration configuration.

| Field | Current Purpose                       | Status  | Notes |
| ----- | ------------------------------------- | ------- | ----- |
| `mcp` | MCP server definitions and enablement | pending |       |

## Group 10: Conversation Lifecycle

Behavior affecting long-running conversations and context management.

| Field        | Current Purpose                                             | Status  | Notes |
| ------------ | ----------------------------------------------------------- | ------- | ----- |
| `compaction` | Automatic compaction, pruning, and context reserve settings | pending |       |

## Group 11: Deprecated And Experimental Settings

Fields that should not be ported by inertia; each needs an explicit justification.

| Field                                | Current Purpose                         | Status  | Notes                                                               |
| ------------------------------------ | --------------------------------------- | ------- | ------------------------------------------------------------------- |
| `layout`                             | Legacy layout selection                 | pending | Deprecated; current description says stretch layout is always used. |
| `experimental.disable_paste_summary` | Disable pasted-content summary behavior | pending |                                                                     |
| `experimental.batch_tool`            | Enable batch tool                       | pending |                                                                     |
| `experimental.openTelemetry`         | Enable AI SDK telemetry spans           | pending |                                                                     |
| `experimental.primary_tools`         | Restrict tools to primary agents        | pending |                                                                     |
| `experimental.continue_loop_on_deny` | Continue loop after denied tool call    | pending |                                                                     |
| `experimental.mcp_timeout`           | MCP request timeout                     | pending | May belong with MCP rather than experiments.                        |

## Review Order

Work through the groups in this order unless a dependency between decisions becomes clear:

1. File Metadata
2. Process And Server Settings
3. Providers And Model Selection
4. Commands And Project Resources
5. Plugins
6. Filesystem And Tool Runtime
7. Sharing And Identity
8. Agents And Permissions
9. Integrations
10. Conversation Lifecycle
11. Deprecated And Experimental Settings
