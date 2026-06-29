import { describe, expect, test } from "bun:test"
import { parseStartupServers } from "./startup-servers"

describe("parseStartupServers", () => {
  test("parses comma separated startup servers", () => {
    expect(parseStartupServers("Dax=http://romulus.example.test:4096, apollo.example.test:4096")).toEqual([
      {
        type: "http",
        displayName: "Dax",
        http: { url: "http://romulus.example.test:4096" },
      },
      {
        type: "http",
        http: { url: "http://apollo.example.test:4096" },
      },
    ])
  })

  test("parses JSON startup servers with credentials", () => {
    expect(
      parseStartupServers(
        JSON.stringify([
          {
            displayName: "Kit box",
            url: "kit.example.test:4096/",
            username: "opencode",
            password: "secret",
          },
        ]),
      ),
    ).toEqual([
      {
        type: "http",
        displayName: "Kit box",
        http: { url: "http://kit.example.test:4096", username: "opencode", password: "secret" },
      },
    ])
  })

  test("parses JSON name to URL maps", () => {
    expect(parseStartupServers('{"Dax":"http://romulus.example.test:4096"}')).toEqual([
      {
        type: "http",
        displayName: "Dax",
        http: { url: "http://romulus.example.test:4096" },
      },
    ])
  })
})
