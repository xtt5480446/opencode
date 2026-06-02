export async function readProviderError(res: Response) {
  const body = await res.text()
  const json = parseJson(body)
  if (json && typeof json === "object") return json as Record<string, any>
  return parseProviderErrorBody(body, res.statusText)
}

export function parseProviderErrorBody(body: string, statusText: string) {
  const text = body.trim()
  const sseData = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter((line) => line && line !== "[DONE]")

  const parsed = sseData.map(parseJson).find((item) => item && typeof item === "object")
  if (parsed) return parsed as Record<string, any>

  return {
    error: {
      message: sseData[0] || text || statusText,
    },
  }
}

function parseJson(value: string) {
  try {
    return JSON.parse(value) as unknown
  } catch {
    return undefined
  }
}
