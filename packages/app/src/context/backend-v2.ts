import type {
  AgentInfo,
  FormCreateInput,
  FormInfo,
  IntegrationInfo,
  McpServer,
  ModelInfo,
  OpenCodeClient,
  OpenCodeEvent,
  PermissionV2Request,
  Project,
  QuestionV2Request,
  SessionInfo,
  SessionMessageAssistant,
  SessionMessageInfo,
  SessionPendingInfo,
  ShellInfo1,
} from "@opencode-ai/client"
import type {
  AppAgent,
  AppClient,
  AppEvent,
  AppFileDiff,
  AppMcpServer,
  AppModel,
  AppPermissionRequest,
  AppProject,
  AppQuestionRequest,
  AppSession,
  FormField,
  IntegrationAttempt,
  IntegrationAttemptStatus,
  IntegrationConnection,
  IntegrationMethod,
  LocationInput,
  LocationRef,
  PendingSessionInput,
  PromptFile,
  RequestOptions,
  SessionActivity,
  SessionLogItem,
  ShellProcess,
  TimelineContent,
  TimelineItem,
} from "./backend"

export function createV2Backend(client: OpenCodeClient, defaultLocation?: LocationRef): AppClient {
  const request = (input?: RequestOptions) => ({ signal: input?.signal })
  const location = (input?: LocationInput) => toLocation(input?.location ?? defaultLocation)

  const loadSession = async (sessionID: string, options?: RequestOptions) =>
    toSession(await client.session.get({ sessionID }, request(options)))
  const loadMessage = async (sessionID: string, messageID: string, options?: RequestOptions) =>
    toTimelineItem(await client.session.message({ sessionID, messageID }, request(options)), sessionID)

  return {
    version: "v2",
    common: {
      health: { get: (options) => client.health.get(request(options)) },
      projects: {
        list: async (options) => (await client.project.list(request(options))).map(toProject),
        current: (input, options) => client.project.current({ location: location(input) }, request(options)),
      },
      catalog: {
        providers: async (input, options) => {
          const params = { location: location(input) }
          const [providers, models, selected] = await Promise.all([
            client.provider.list(params, request(options)),
            client.model.list(params, request(options)),
            client.model.default(params, request(options)),
          ])
          return {
            providers: new Map(
              providers.data.map((provider) => [
                provider.id,
                {
                  id: provider.id,
                  name: provider.name,
                  models: Object.fromEntries(
                    models.data
                      .filter((model) => model.providerID === provider.id && model.status !== "deprecated")
                      .map((model) => [model.id, toModel(model)]),
                  ),
                },
              ]),
            ),
            connected: providers.data.filter((provider) => !provider.disabled).map((provider) => provider.id),
            defaults: selected.data ? { [selected.data.providerID]: selected.data.id } : {},
          }
        },
        agents: async (input, options) =>
          (await client.agent.list({ location: location(input) }, request(options))).data.map(toAgent),
      },
      commands: {
        list: async (input, options) =>
          (await client.command.list({ location: location(input) }, request(options))).data.map((item) => ({
            name: item.name,
            description: item.description,
          })),
      },
      references: {
        list: async (input, options) =>
          (await client.reference.list({ location: location(input) }, request(options))).data.map((item) => ({
            name: item.name,
            path: item.path,
            description: item.description,
            hidden: item.hidden,
            source: item.source,
          })),
      },
      sessions: {
        list: async (input, options) => {
          const result = await client.session.list(
            {
              workspace: input?.location?.workspaceID ?? defaultLocation?.workspaceID,
              directory: input?.location?.directory ?? defaultLocation?.directory,
              parentID: input?.roots ? null : undefined,
              limit: input?.limit,
              search: input?.search,
              cursor: input?.cursor,
            },
            request(options),
          )
          return {
            items: result.data.map(toSession),
            previous: result.cursor.previous ?? undefined,
            next: result.cursor.next ?? undefined,
          }
        },
        create: async (input, options) =>
          toSession(
            await client.session.create(
              { location: input?.location ?? defaultLocation, agent: input?.agent, model: input?.model },
              request(options),
            ),
          ),
        get: (input, options) => loadSession(input.sessionID, options),
        remove: async (input, options) => {
          await client.session.remove({ sessionID: input.sessionID }, request(options))
        },
        fork: async (input, options) =>
          toSession(await client.session.fork({ sessionID: input.sessionID, messageID: input.messageID }, request(options))),
        rename: async (input, options) => {
          await client.session.rename({ sessionID: input.sessionID, title: input.title }, request(options))
        },
        interrupt: async (input, options) => {
          await client.session.interrupt({ sessionID: input.sessionID }, request(options))
        },
        activity: async (_input, options) => {
          const result = await client.session.active(request(options))
          return Object.fromEntries(Object.keys(result).map((sessionID) => [sessionID, { type: "running" } as const]))
        },
        history: async (input, options) => {
          const result = await client.message.list(
            { sessionID: input.sessionID, limit: input.limit, cursor: input.cursor },
            request(options),
          )
          return {
            items: result.data.map((item) => toTimelineItem(item, input.sessionID)),
            previous: result.cursor.previous ?? undefined,
            next: result.cursor.next ?? undefined,
          }
        },
        message: (input, options) => loadMessage(input.sessionID, input.messageID, options),
        prompt: async (input, options) => {
          if (input.selection?.agent)
            await client.session.switchAgent(
              { sessionID: input.sessionID, agent: input.selection.agent },
              request(options),
            )
          if (input.selection?.model)
            await client.session.switchModel(
              { sessionID: input.sessionID, model: input.selection.model },
              request(options),
            )
          await client.session.prompt(
            {
              sessionID: input.sessionID,
              id: input.id,
              text: input.text,
              files: input.files?.map(toPromptFile),
              agents: input.agents?.map((agent) => ({
                name: agent.name,
                mention:
                  agent.start === undefined || agent.end === undefined || agent.text === undefined
                    ? undefined
                    : { start: agent.start, end: agent.end, text: agent.text },
              })),
              delivery: input.delivery,
            },
            request(options),
          )
        },
        command: async (input, options) => {
          await client.session.command(
            {
              sessionID: input.sessionID,
              id: input.id,
              command: input.command,
              arguments: input.arguments,
              agent: input.agent,
              model: input.model,
              files: input.files?.map(toPromptFile),
              delivery: input.delivery,
            },
            request(options),
          )
        },
      },
      files: {
        list: async (input, options) =>
          (await client.file.list({ location: location(input), path: input.path }, request(options))).data,
        find: async (input, options) =>
          (
            await client.file.find(
              { location: location(input), query: input.query, type: input.type, limit: input.limit },
              request(options),
            )
          ).data,
        read: async (input, options) => ({
          bytes: await client.file.read({ location: location(input), path: input.path }, request(options)),
        }),
      },
      permissions: {
        pending: async (input, options) =>
          (await client.permission.request.list({ location: location(input) }, request(options))).data.map(toPermission),
        reply: async (input, options) => {
          await client.permission.reply(input, request(options))
        },
      },
      questions: {
        pending: async (input, options) =>
          (await client.question.request.list({ location: location(input) }, request(options))).data.map(toQuestion),
        reply: async (input, options) => {
          await client.question.reply({ ...input, answers: input.answers.map((answer) => [...answer]) }, request(options))
        },
        reject: async (input, options) => {
          await client.question.reject(input, request(options))
        },
      },
      vcs: {
        status: async (input, options) =>
          (await client.vcs.status({ location: location(input) }, request(options))).data,
        diff: async (input, options) =>
          (await client.vcs.diff({ ...input, location: location(input) }, request(options))).data.map(toFileDiff),
      },
      mcp: {
        list: async (input, options) =>
          (await client.mcp.list({ location: location(input) }, request(options))).data.map(toMcpServer),
        resources: async (input, options) =>
          (await client.mcp.resource.catalog({ location: location(input) }, request(options))).data,
      },
      pty: {
        list: async (input, options) =>
          (await client.pty.list({ location: location(input) }, request(options))).data.map(toPty),
        create: async (input, options) =>
          toPty(
            (
              await client.pty.create(
                {
                  location: location(input),
                  title: input.title,
                  command: input.command,
                  args: input.args,
                  cwd: input.cwd,
                  env: input.env,
                },
                request(options),
              )
            ).data,
          ),
        get: async (input, options) =>
          toPty((await client.pty.get({ ptyID: input.ptyID, location: location(input) }, request(options))).data),
        update: async (input, options) =>
          toPty(
            (
              await client.pty.update(
                { ptyID: input.ptyID, location: location(input), title: input.title, size: input.size },
                request(options),
              )
            ).data,
          ),
        remove: async (input, options) => {
          await client.pty.remove({ ptyID: input.ptyID, location: location(input) }, request(options))
        },
      },
      events: {
        subscribe: (options) => ({
          async *[Symbol.asyncIterator]() {
            for await (const input of client.event.subscribe(request(options))) {
              yield {
                location: input.location,
                event: await toEvent(input, loadSession, loadMessage, options),
              }
            }
          },
        }),
      },
      disposeLocation: async (input, options) => {
        await client.debug.location.evict({ location: location(input) }, request(options))
      },
    },
    capabilities: {
      integrationsV2: {
        list: async (input, options) =>
          (await client.integration.list({ location: location(input) }, request(options))).data.map(toIntegration),
        get: async (input, options) => {
          const result = await client.integration.get(
            { integrationID: input.integrationID, location: location(input) },
            request(options),
          )
          return result.data ? toIntegration(result.data) : null
        },
        connectKey: async (input, options) => {
          await client.integration.connect.key({ ...input, location: location(input) }, request(options))
        },
        connectOauth: async (input, options) =>
          toIntegrationAttempt(
            (
              await client.integration.connect.oauth(
                {
                  integrationID: input.integrationID,
                  methodID: input.methodID,
                  inputs: input.values,
                  label: input.label,
                  location: location(input),
                },
                request(options),
              )
            ).data,
          ),
        attemptStatus: async (input, options) =>
          toAttemptStatus(
            (
              await client.integration.attempt.status(
                { attemptID: input.attemptID, location: location(input) },
                request(options),
              )
            ).data,
          ),
        completeAttempt: async (input, options) => {
          await client.integration.attempt.complete({ ...input, location: location(input) }, request(options))
        },
        cancelAttempt: async (input, options) => {
          await client.integration.attempt.cancel({ ...input, location: location(input) }, request(options))
        },
        renameCredential: async (input, options) => {
          await client.credential.update({ ...input, location: location(input) }, request(options))
        },
        removeCredential: async (input, options) => {
          await client.credential.remove({ ...input, location: location(input) }, request(options))
        },
      },
      sessionExtrasV2: {
        switchAgent: async (input, options) => {
          await client.session.switchAgent(input, request(options))
        },
        switchModel: async (input, options) => {
          await client.session.switchModel(input, request(options))
        },
        move: async (input, options) => {
          await client.session.move(
            { sessionID: input.sessionID, destination: { directory: input.directory }, moveChanges: input.moveChanges },
            request(options),
          )
        },
        skill: async (input, options) => {
          await client.session.skill(input, request(options))
        },
        synthetic: async (input, options) =>
          toPending(
            await client.session.synthetic(
              { ...input, metadata: input.metadata && toClientRecord(input.metadata) },
              request(options),
            ),
          ),
        shell: async (input, options) => {
          await client.session.shell(input, request(options))
        },
        compact: async (input, options) => toPending(await client.session.compact(input, request(options))),
        wait: async (input, options) => {
          await client.session.wait(input, request(options))
        },
        context: async (input, options) =>
          (await client.session.context(input, request(options))).map((item) => toTimelineItem(item, input.sessionID)),
        pending: async (input, options) =>
          (await client.session.pending.list(input, request(options))).map(toPending),
        instructionEntries: (input, options) => client.session.instructions.entry.list(input, request(options)),
        putInstructionEntry: async (input, options) => {
          await client.session.instructions.entry.put({ ...input, value: toClientJson(input.value) }, request(options))
        },
        removeInstructionEntry: async (input, options) => {
          await client.session.instructions.entry.remove(input, request(options))
        },
        log: (input, options) => ({
          async *[Symbol.asyncIterator]() {
            for await (const item of client.session.log(input, request(options))) {
              yield {
                sequence: "durable" in item ? item.durable.seq : (item.seq ?? 0),
                event: await toLogEvent(item, loadSession, loadMessage, options),
              } satisfies SessionLogItem
            }
          },
        }),
        background: async (input, options) => {
          await client.session.background(input, request(options))
        },
        stageRevert: async (input, options) => {
          const result = await client.session.revert.stage(
            { sessionID: input.sessionID, messageID: input.messageID, files: input.files?.length ? true : undefined },
            request(options),
          )
          return { messageID: result.messageID }
        },
        clearRevert: async (input, options) => {
          await client.session.revert.clear(input, request(options))
        },
        commitRevert: async (input, options) => {
          await client.session.revert.commit(input, request(options))
        },
      },
      projectCopiesV2: {
        directories: (input, options) =>
          client.project.directories({ projectID: input.projectID, location: location(input) }, request(options)),
        create: (input, options) => client.projectCopy.create({ ...input, location: location(input) }, request(options)),
        remove: async (input, options) => {
          await client.projectCopy.remove({ ...input, location: location(input) }, request(options))
        },
        refresh: async (input, options) => {
          await client.projectCopy.refresh({ ...input, location: location(input) }, request(options))
        },
      },
      formsV2: {
        pending: async (input, options) =>
          (await client.form.request.list({ location: location(input) }, request(options))).data.map(toForm),
        list: async (input, options) => (await client.form.list(input, request(options))).map(toForm),
        create: async (input, options) => {
          if (input.fields.length === 0) throw new Error("A form requires at least one field")
          const fields: FormCreateInput["fields"] = [
            fromFormField(input.fields[0]),
            ...input.fields.slice(1).map(fromFormField),
          ]
          return toForm(
            await client.form.create(
              { ...input, metadata: input.metadata && toClientRecord(input.metadata), fields },
              request(options),
            ),
          )
        },
        get: async (input, options) => toForm(await client.form.get(input, request(options))),
        state: (input, options) => client.form.state(input, request(options)),
        reply: async (input, options) => {
          await client.form.reply({ ...input, answer: { ...input.answer } }, request(options))
        },
        cancel: async (input, options) => {
          await client.form.cancel(input, request(options))
        },
      },
      savedPermissionsV2: {
        list: (input, options) => client.permission.saved.list(input, request(options)),
        remove: async (input, options) => {
          await client.permission.saved.remove(input, request(options))
        },
      },
      shellsV2: {
        list: async (input, options) =>
          (await client.shell.list({ location: location(input) }, request(options))).data.map(toShell),
        create: async (input, options) =>
          toShell(
            (
              await client.shell.create(
                {
                  ...input,
                  metadata: input.metadata && toClientRecord(input.metadata),
                  location: location(input),
                },
                request(options),
              )
            ).data,
          ),
        get: async (input, options) =>
          toShell((await client.shell.get({ id: input.id, location: location(input) }, request(options))).data),
        setTimeout: async (input, options) =>
          toShell(
            (
              await client.shell.timeout(
                { id: input.id, timeout: input.timeout, location: location(input) },
                request(options),
              )
            ).data,
          ),
        output: async (input, options) =>
          (
            await client.shell.output(
              { id: input.id, cursor: input.cursor, limit: input.limit, location: location(input) },
              request(options),
            )
          ).data,
        remove: async (input, options) => {
          await client.shell.remove({ id: input.id, location: location(input) }, request(options))
        },
      },
      discoveryV2: {
        server: (options) => client.server.get(request(options)),
        location: (input, options) => client.location.get({ location: location(input) }, request(options)),
        plugins: async (input, options) =>
          (await client.plugin.list({ location: location(input) }, request(options))).data,
        skills: async (input, options) => {
          const result = await client.skill.list({ location: location(input) }, request(options))
          return result.data.map((item) => ({
            ...item,
            location: { directory: item.location },
          }))
        },
        models: async (input, options) =>
          (await client.model.list({ location: location(input) }, request(options))).data.map(toModel),
        defaultModel: async (input, options) => {
          const result = await client.model.default({ location: location(input) }, request(options))
          return result.data ? toModel(result.data) : null
        },
        generateText: async (input, options) =>
          (await client.generate.text({ ...input, location: location(input) }, request(options))).text,
        loadedLocations: (options) => client.debug.location.list(request(options)),
      },
    },
  }
}

function toLocation(input?: LocationRef) {
  if (!input) return
  return { directory: input.directory, workspace: input.workspaceID }
}

function toProject(input: Project): AppProject {
  return {
    id: input.id,
    worktree: input.worktree,
    name: input.name,
    icon: input.icon,
    commands: input.commands,
    sandboxes: input.sandboxes,
  }
}

function toSession(input: SessionInfo): AppSession {
  return {
    id: input.id,
    parentID: input.parentID,
    projectID: input.projectID,
    location: input.location,
    title: input.title,
    cost: input.cost,
    tokens: input.tokens,
    time: input.time,
    revert: input.revert && { messageID: input.revert.messageID },
  }
}

function toModel(input: ModelInfo): AppModel {
  const cost = input.cost[0]
  return {
    id: input.id,
    providerID: input.providerID,
    name: input.name,
    family: input.family,
    releaseDate: new Date(input.time.released).toISOString().slice(0, 10),
    cost: cost && { input: cost.input, output: cost.output, cacheRead: cost.cache.read, cacheWrite: cost.cache.write },
    capabilities: {
      reasoning: input.capabilities.output.includes("reasoning"),
      input: {
        text: input.capabilities.input.includes("text"),
        image: input.capabilities.input.includes("image"),
        audio: input.capabilities.input.includes("audio"),
        video: input.capabilities.input.includes("video"),
        pdf: input.capabilities.input.includes("pdf"),
      },
    },
    limit: { context: input.limit.context, output: input.limit.output },
    variants: Object.fromEntries(input.variants.map((variant) => [variant.id, variant])),
  }
}

function toAgent(input: AgentInfo): AppAgent {
  return {
    id: input.id,
    name: input.name,
    description: input.description,
    mode: input.mode,
    hidden: input.hidden,
    color: input.color,
    model: input.model,
  }
}

function toTimelineItem(input: SessionMessageInfo, sessionID: string): TimelineItem {
  if (input.type === "user") {
    return {
      type: "user",
      id: input.id,
      sessionID,
      created: input.time.created,
      content: [
        { type: "text", id: `${input.id}:text`, text: input.text },
        ...(input.files?.map((file, index) => ({
          type: "file" as const,
          id: `${input.id}:file:${index}`,
          uri: file.source.type === "uri" ? file.source.uri : `data:${file.mime};base64,${file.data}`,
          name: file.name,
        })) ?? []),
        ...(input.agents?.map((agent, index) => ({
          type: "agent" as const,
          id: `${input.id}:agent:${index}`,
          name: agent.name,
          source: agent.mention,
        })) ?? []),
      ],
      raw: input,
    }
  }
  if (input.type === "assistant") return toAssistant(input, sessionID)
  const type =
    input.type === "agent-switched"
      ? "agent-switch"
      : input.type === "model-switched"
        ? "model-switch"
        : input.type
  return { type, id: input.id, sessionID, created: input.time.created, raw: input }
}

function toAssistant(input: SessionMessageAssistant, sessionID: string): TimelineItem {
  return {
    type: "assistant",
    id: input.id,
    sessionID,
    created: input.time.created,
    completed: input.time.completed,
    content: input.content.flatMap((item, index): TimelineContent[] => {
      if (item.type === "text") return [{ type: "text", id: `${input.id}:text:${index}`, text: item.text }]
      if (item.type === "reasoning")
        return [{ type: "reasoning", id: `${input.id}:reasoning:${index}`, text: item.text }]
      if (item.state.status === "streaming")
        return [
          {
            type: "tool",
            id: item.id,
            tool: item.name,
            state: { status: "pending", input: {}, raw: item.state.input },
          },
        ]
      if (item.state.status === "running")
        return [
          {
            type: "tool",
            id: item.id,
            tool: item.name,
            state: { status: "running", input: item.state.input, metadata: item.state.structured },
          },
        ]
      if (item.state.status === "error")
        return [
          {
            type: "tool",
            id: item.id,
            tool: item.name,
            state: {
              status: "error",
              input: item.state.input,
              error: item.state.error.message,
              metadata: item.state.structured,
            },
          },
        ]
      return [
        {
          type: "tool",
          id: item.id,
          tool: item.name,
          state: {
            status: "completed",
            input: item.state.input,
            output: item.state.content
              .map((content) => (content.type === "text" ? content.text : content.uri))
              .join("\n"),
            metadata: item.state.structured,
          },
        },
      ]
    }),
    agent: input.agent,
    model: input.model,
    tokens: input.tokens,
    error: input.error,
    raw: input,
  }
}

function toPromptFile(input: PromptFile) {
  return {
    uri: input.uri,
    name: input.name,
    mention: input.source && { start: input.source.start, end: input.source.end, text: input.source.text },
  }
}

function toPermission(input: PermissionV2Request): AppPermissionRequest {
  return {
    id: input.id,
    sessionID: input.sessionID,
    action: input.action,
    resources: input.resources,
    metadata: input.metadata,
  }
}

function toQuestion(input: QuestionV2Request): AppQuestionRequest {
  return { id: input.id, sessionID: input.sessionID, questions: input.questions }
}

function toFileDiff(input: { file: string; patch: string; additions: number; deletions: number; status: "added" | "deleted" | "modified" }): AppFileDiff {
  return input
}

function toMcpServer(input: McpServer): AppMcpServer {
  return { name: input.name, status: input.status, integrationID: input.integrationID }
}

function toPty(input: { id: string; title: string }) {
  return { id: input.id, title: input.title }
}

function toIntegration(input: IntegrationInfo) {
  return {
    id: input.id,
    name: input.name,
    methods: input.methods.map((method): IntegrationMethod => {
      if (method.type === "oauth") return method
      if (method.type === "key") return { type: "key", label: method.label ?? "API key" }
      return { type: "environment", label: method.names.join(", ") }
    }),
    connections: input.connections.map((connection): IntegrationConnection =>
      connection.type === "credential"
        ? { id: connection.id, label: connection.label }
        : { id: connection.name, label: connection.name },
    ),
  }
}

function toIntegrationAttempt(input: {
  attemptID: string
  url: string
  instructions: string
  mode: "auto" | "code"
  time: { created: number | string; expires: number | string }
}): IntegrationAttempt {
  return {
    ...input,
    time: { created: Number(input.time.created), expires: Number(input.time.expires) },
  }
}

function toAttemptStatus(input: import("@opencode-ai/client").IntegrationAttemptStatus): IntegrationAttemptStatus {
  if (input.status === "failed") return { status: input.status, error: input.message }
  return { status: input.status }
}

function toPending(input: SessionPendingInfo): PendingSessionInput {
  return {
    id: input.id,
    sessionID: input.sessionID,
    sequence: input.admittedSeq,
    created: input.timeCreated,
    delivery: "delivery" in input ? input.delivery : undefined,
    raw: input,
  }
}

function toForm(input: FormInfo) {
  return {
    id: input.id,
    sessionID: input.sessionID,
    title: input.title,
    metadata: input.metadata,
    fields: input.fields.map((field): FormField => {
      if (field.type === "external")
        return {
          type: field.type,
          key: field.key,
          label: field.title ?? field.key,
          url: field.url,
          description: field.description,
        }
      if (field.type === "multiselect")
        return {
          type: field.type,
          key: field.key,
          label: field.title ?? field.key,
          options: field.options.map((option) => option.value),
          required: field.required,
          description: field.description,
        }
      return {
        type: field.type,
        key: field.key,
        label: field.title ?? field.key,
        required: field.required,
        description: field.description,
      }
    }),
  }
}

function fromFormField(input: FormField): FormCreateInput["fields"][number] {
  if (input.type === "external")
    return { type: input.type, key: input.key, title: input.label, url: input.url, description: input.description }
  if (input.type === "multiselect")
    return {
      type: input.type,
      key: input.key,
      title: input.label,
      options: input.options.map((option) => ({ value: option, label: option })),
      required: input.required,
      description: input.description,
    }
  return {
    type: input.type,
    key: input.key,
    title: input.label,
    required: input.type === "boolean" ? undefined : input.required,
    description: input.description,
  }
}

function toClientRecord(input: Readonly<Record<string, import("./backend").JsonValue>>) {
  return Object.fromEntries(Object.entries(input).map(([key, value]) => [key, toClientJson(value)]))
}

function toClientJson(input: import("./backend").JsonValue): import("@opencode-ai/client").JsonValue {
  if (isJsonArray(input)) return input.map(toClientJson)
  if (input && typeof input === "object") return toClientRecord(input)
  return input
}

function isJsonArray(input: import("./backend").JsonValue): input is readonly import("./backend").JsonValue[] {
  return Array.isArray(input)
}

function toShell(input: ShellInfo1): ShellProcess {
  return {
    id: input.id,
    command: input.command,
    cwd: input.cwd,
    status: input.status === "running" ? "running" : "exited",
    created: input.time.started,
    exitCode: input.exit,
    metadata: input.metadata,
  }
}

async function toEvent(
  input: OpenCodeEvent,
  loadSession: (sessionID: string, options?: RequestOptions) => Promise<AppSession>,
  loadMessage: (sessionID: string, messageID: string, options?: RequestOptions) => Promise<TimelineItem>,
  options?: RequestOptions,
): Promise<AppEvent> {
  if (input.type === "server.connected") return { type: input.type }
  if (input.type === "session.deleted") return { type: input.type, sessionID: input.data.sessionID }
  if (input.type === "session.error") return { type: input.type, sessionID: input.data.sessionID, error: input.data.error }
  if (input.type === "session.status") {
    const activity = toActivity(input.data.status)
    return activity
      ? { type: "session.activity", sessionID: input.data.sessionID, activity }
      : { type: "unknown", raw: input }
  }
  if (input.type === "session.execution.started")
    return { type: "session.activity", sessionID: input.data.sessionID, activity: { type: "running" } }
  if (input.type === "session.retry.scheduled")
    return {
      type: "session.activity",
      sessionID: input.data.sessionID,
      activity: {
        type: "retry",
        attempt: input.data.attempt,
        message: input.data.error.message,
        next: input.data.at,
      },
    }
  if (input.type === "session.execution.failed")
    return { type: "session.error", sessionID: input.data.sessionID, error: input.data.error }
  if (input.type === "session.idle") return { type: "unknown", raw: input }
  if (input.type === "permission.v2.asked") return { type: "permission.requested", request: toPermission(input.data) }
  if (input.type === "permission.v2.replied")
    return { type: "permission.replied", sessionID: input.data.sessionID, requestID: input.data.requestID }
  if (input.type === "question.v2.asked") return { type: "question.requested", request: toQuestion(input.data) }
  if (input.type === "question.v2.replied" || input.type === "question.v2.rejected")
    return {
      type: input.type === "question.v2.replied" ? "question.replied" : "question.rejected",
      sessionID: input.data.sessionID,
      requestID: input.data.requestID,
    }
  if (input.type === "filesystem.changed")
    return { type: "file.changed", path: input.data.file, change: input.data.event }
  if (input.type === "vcs.branch.updated") return { type: input.type, branch: input.data.branch }
  if (input.type === "pty.exited") return { type: input.type, ptyID: input.data.id }
  if (input.type === "message.removed")
    return { type: "timeline.removed", sessionID: input.data.sessionID, itemID: input.data.messageID }
  if (input.type === "message.updated")
    return {
      type: "timeline.updated",
      item: await loadMessage(input.data.sessionID, input.data.info.id, options),
    }
  if (input.type === "message.part.updated")
    return {
      type: "timeline.updated",
      item: await loadMessage(input.data.sessionID, input.data.part.messageID, options),
    }

  const sessionID = eventSessionID(input)
  const messageID = eventMessageID(input)
  if (sessionID && messageID)
    return { type: "timeline.updated", item: await loadMessage(sessionID, messageID, options) }
  if (sessionID && isSessionProjectionEvent(input.type)) {
    const session = await loadSession(sessionID, options)
    return { type: input.type === "session.created" ? "session.created" : "session.updated", session }
  }
  return { type: "unknown", raw: input }
}

function toActivity(input: import("@opencode-ai/client").SessionStatus): SessionActivity | undefined {
  if (input.type === "idle") return
  if (input.type === "busy") return { type: "running" }
  return input
}

function eventSessionID(input: OpenCodeEvent) {
  if (!("data" in input) || typeof input.data !== "object" || input.data === null || !("sessionID" in input.data)) return
  return typeof input.data.sessionID === "string" ? input.data.sessionID : undefined
}

function eventMessageID(input: OpenCodeEvent) {
  if (!("data" in input) || typeof input.data !== "object" || input.data === null) return
  if ("assistantMessageID" in input.data && typeof input.data.assistantMessageID === "string")
    return input.data.assistantMessageID
  if ("messageID" in input.data && typeof input.data.messageID === "string") return input.data.messageID
  if (input.type === "session.input.promoted") return input.data.inputID
}

function isSessionProjectionEvent(type: string) {
  return [
    "session.created",
    "session.updated",
    "session.agent.selected",
    "session.model.selected",
    "session.moved",
    "session.renamed",
    "session.usage.updated",
    "session.revert.staged",
    "session.revert.cleared",
    "session.revert.committed",
  ].includes(type)
}

async function toLogEvent(
  input: import("@opencode-ai/client").SessionLogOutput,
  loadSession: (sessionID: string, options?: RequestOptions) => Promise<AppSession>,
  loadMessage: (sessionID: string, messageID: string, options?: RequestOptions) => Promise<TimelineItem>,
  options?: RequestOptions,
): Promise<AppEvent> {
  if (input.type === "log.synced") return { type: "unknown", raw: input }
  return toEvent(input, loadSession, loadMessage, options)
}
