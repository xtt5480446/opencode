import { CommandV2 } from "@opencode-ai/core/command"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../../api"

export const commandHandlers = HttpApiBuilder.group(InstanceHttpApi, "v2.command", (handlers) =>
  handlers.handle("commands", () => CommandV2.Service.use((command) => command.list())),
)
