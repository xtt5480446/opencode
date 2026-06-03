import { CommandV2 } from "@opencode-ai/core/command"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../../api"
import { response } from "../../groups/v2/location"

export const commandHandlers = HttpApiBuilder.group(InstanceHttpApi, "v2.command", (handlers) =>
  handlers.handle("commands", () => response(CommandV2.Service.use((command) => command.list()))),
)
