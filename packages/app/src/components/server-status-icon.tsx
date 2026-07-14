import "./server-status-icon.css"

export type ServerStatusIconState = "reconnecting" | "disconnected"
export type ServerConnectionState = "connecting" | "connected" | "reconnecting"

export function resolveServerStatus(healthy: boolean | undefined, connection: ServerConnectionState) {
  if (healthy === false) return "disconnected" as const
  if (connection === "reconnecting") return "reconnecting" as const
}

export function ServerStatusIcon(props: { state: ServerStatusIconState }) {
  return (
    <svg
      data-component="server-status-icon"
      data-state={props.state}
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <path
        d="M13.3141 6.00001V14.4572H2.68555V1.54285H9.5M13.3141 14.4572V9.54285H2.68555V14.4572"
        stroke="currentColor"
      />
      <path data-slot="server-status-left" d="M8.5 11.75H8V12.25H8.5Z" />
      <path data-slot="server-status-right" d="M11 11.75H10.5V12.25H11Z" />
      <path
        data-slot="server-status-dot"
        d="M13 5C14.3807 5 15.5 3.88071 15.5 2.5C15.5 1.11929 14.3807 0 13 0C11.6193 0 10.5 1.11929 10.5 2.5C10.5 3.88071 11.6193 5 13 5Z"
      />
    </svg>
  )
}
