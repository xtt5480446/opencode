import { expect, test } from "bun:test"
import { collapseToolOutput, collapseToolOutputParts } from "../../../src/util/collapse-tool-output"

test("limits command input and output to the same line budget", () => {
  const command = Array.from({ length: 8 }, (_, index) => `command ${index + 1}`).join("\n")
  const output = Array.from({ length: 4 }, (_, index) => `output ${index + 1}`).join("\n")
  const collapsed = collapseToolOutput(`$ ${command}\n\n${output}`, 10, 1_000)

  expect(collapsed.overflow).toBe(true)
  expect(collapsed.output.split("\n")).toHaveLength(10)
  expect(collapsed.output).toContain("$ command 1")
  expect(collapsed.output).toContain("command 8\n\noutput 1…")
  expect(collapsed.output).not.toContain("output 2")
})

test.each([
  {
    name: "inside the command",
    maxChars: 5,
    expected: { input: "$ co…", output: "", overflow: true },
  },
  {
    name: "after the command",
    maxChars: 10,
    expected: { input: "$ command…", output: "", overflow: true },
  },
  {
    name: "on the first separator newline",
    maxChars: 11,
    expected: { input: "$ command…", output: "", overflow: true },
  },
  {
    name: "on the second separator newline",
    maxChars: 12,
    expected: { input: "$ command…", output: "", overflow: true },
  },
  {
    name: "inside the output",
    maxChars: 15,
    expected: { input: "$ command", output: "out…", overflow: true },
  },
])("keeps the ellipsis with the visible $name", ({ maxChars, expected }) => {
  expect(collapseToolOutputParts("$ command", "output", 10, maxChars)).toEqual(expected)
})
