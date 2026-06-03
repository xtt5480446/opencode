import { SkillV2 } from "@opencode-ai/core/skill"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../../api"
import { response } from "../../groups/v2/location"

export const skillHandlers = HttpApiBuilder.group(InstanceHttpApi, "v2.skill", (handlers) =>
  handlers.handle("skills", () => response(SkillV2.Service.use((skill) => skill.list()))),
)
