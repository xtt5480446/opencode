import { createMemo, onMount } from "solid-js"
import { useSync } from "@tui/context/sync"
import { DialogSelect, type DialogSelectOption } from "@tui/ui/dialog-select"
import type { TextPart } from "@opencode-ai/sdk/v2"
import { Locale } from "@/util/locale"
import { useSDK } from "@tui/context/sdk"
import { useRoute } from "@tui/context/route"
import { useToast } from "../../ui/toast"
import { Spinner } from "../../component/spinner"
import { useDialog, type DialogContext } from "../../ui/dialog"
import type { PromptInfo } from "@tui/component/prompt/history"
import { strip } from "@tui/component/prompt/part"

export function DialogForkFromTimeline(props: { sessionID: string; onMove: (messageID?: string) => void }) {
  const sync = useSync()
  const dialog = useDialog()
  const sdk = useSDK()
  const route = useRoute()
  const toast = useToast()

  onMount(() => {
    dialog.setSize("large")
  })

  // Forking a large session can take a moment, so swap the dialog to a progress view instead of
  // leaving it open (which looks frozen), then navigate to the fork and confirm with a toast.
  const fork = async (dialog: DialogContext, messageID?: string, prompt?: PromptInfo) => {
    dialog.replace(() => (
      <box paddingLeft={2} paddingRight={2} paddingBottom={1}>
        <Spinner>Forking session…</Spinner>
      </box>
    ))
    const forked = await sdk.client.session.fork({ sessionID: props.sessionID, messageID })
    if (!forked.data) {
      toast.show({ variant: "error", message: "Failed to fork session" })
      dialog.clear()
      return
    }
    route.navigate({ sessionID: forked.data.id, type: "session", prompt })
    dialog.clear()
    toast.show({ variant: "success", message: "Forked session", duration: 4000 })
  }

  const options = createMemo((): DialogSelectOption<string | undefined>[] => {
    const messages = sync.data.message[props.sessionID] ?? []
    const fullSession = {
      title: "Full session",
      value: undefined,
      onSelect: fork,
    } satisfies DialogSelectOption<string | undefined>
    const result = [] as DialogSelectOption<string | undefined>[]
    for (const message of messages) {
      if (message.role !== "user") continue
      const part = (sync.data.part[message.id] ?? []).find(
        (x) => x.type === "text" && !x.synthetic && !x.ignored,
      ) as TextPart
      if (!part) continue
      result.push({
        title: part.text.replace(/\n/g, " "),
        value: message.id,
        footer: Locale.time(message.time.created),
        onSelect: (dialog) => {
          const prompt = (sync.data.part[message.id] ?? []).reduce(
            (agg, part) => {
              if (part.type === "text") {
                if (!part.synthetic) agg.input += part.text
              }
              if (part.type === "file") agg.parts.push(strip(part))
              return agg
            },
            { input: "", parts: [] as PromptInfo["parts"] },
          )
          return fork(dialog, message.id, prompt)
        },
      })
    }
    return [fullSession, ...result.reverse()]
  })

  return <DialogSelect onMove={(option) => props.onMove(option.value)} title="Fork session" options={options()} />
}
