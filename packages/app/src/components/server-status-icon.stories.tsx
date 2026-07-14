import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { ServerStatusIcon, type ServerStatusIconState } from "./server-status-icon"

export default {
  title: "Desktop V2/Server Status Icon",
  id: "desktop-v2-server-status-icon",
  component: ServerStatusIcon,
  tags: ["autodocs"],
}

function Preview(props: { state: ServerStatusIconState; label: string }) {
  return (
    <div class="flex items-center gap-3">
      <IconButtonV2
        type="button"
        variant="ghost-muted"
        size="large"
        class="!w-9 shrink-0"
        aria-label={props.label}
        icon={<ServerStatusIcon state={props.state} />}
      />
      <span class="text-[13px] text-v2-text-text-muted">{props.label}</span>
    </div>
  )
}

export const Reconnecting = {
  render: () => <Preview state="reconnecting" label="Retrying automatically..." />,
}

export const Disconnected = {
  render: () => <Preview state="disconnected" label="Server disconnected" />,
}
