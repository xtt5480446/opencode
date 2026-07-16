export function collapseToolOutput(output: string, maxLines: number, maxChars: number) {
  const lines = output.split("\n")
  if (lines.length <= maxLines && Array.from(output).length <= maxChars) {
    return { output, overflow: false }
  }

  const visible = lines.slice(0, maxLines)
  if (lines.length > maxLines && visible.length > 0) visible[visible.length - 1] += "…"
  const preview = visible.join("\n")
  if (Array.from(preview).length > maxChars) {
    return {
      output:
        Array.from(preview)
          .slice(0, Math.max(0, maxChars - 1))
          .join("") + "…",
      overflow: true,
    }
  }

  return { output: preview, overflow: true }
}

export function collapseToolOutputParts(input: string, output: string, maxLines: number, maxChars: number) {
  const separator = input && output ? "\n\n" : ""
  const collapsed = collapseToolOutput(`${input}${separator}${output}`, maxLines, maxChars)
  if (!collapsed.overflow) return { input, output, overflow: false }

  const ellipsis = collapsed.output.endsWith("…") ? "…" : ""
  const preview = ellipsis ? collapsed.output.slice(0, -1) : collapsed.output
  const outputStart = input.length + separator.length
  if (preview.length <= outputStart) {
    return {
      input: preview.slice(0, input.length) + ellipsis,
      output: "",
      overflow: true,
    }
  }

  return {
    input,
    output: preview.slice(outputStart) + ellipsis,
    overflow: true,
  }
}
