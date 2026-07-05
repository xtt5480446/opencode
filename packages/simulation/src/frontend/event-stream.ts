import { SimulationLog } from "../log"

export type State = "connected" | "paused" | "reconnecting"

const state = {
  paused: false,
  connection: undefined as AbortController | undefined,
  resume: new Set<() => void>(),
}

export function attach(connection: AbortController) {
  state.connection = connection
  SimulationLog.add("event-stream.attach")
  return () => {
    if (state.connection === connection) state.connection = undefined
    SimulationLog.add("event-stream.detach")
  }
}

export function pause() {
  state.paused = true
  state.connection?.abort(new Error("Simulation paused the event stream"))
  SimulationLog.add("event-stream.pause")
}

export function resume() {
  state.paused = false
  for (const resolve of state.resume) resolve()
  state.resume.clear()
  SimulationLog.add("event-stream.resume")
}

export async function beforeConnect(signal: AbortSignal) {
  if (!state.paused) return
  await new Promise<void>((resolve, reject) => {
    const abort = () => {
      state.resume.delete(done)
      reject(signal.reason)
    }
    const done = () => {
      signal.removeEventListener("abort", abort)
      resolve()
    }
    state.resume.add(done)
    signal.addEventListener("abort", abort, { once: true })
  })
}

export function current(): State {
  if (state.paused) return "paused"
  return state.connection === undefined ? "reconnecting" : "connected"
}

export * as SimulationEventStream from "./event-stream"
