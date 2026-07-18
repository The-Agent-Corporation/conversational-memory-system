import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, it } from "vitest";

describe("MCP SDK-driven STDIO lifecycle contract", () => {
  it("uses the pinned official SDK client and STDIO transport generation", () => {
    expect(Client).toBeTypeOf("function");
    expect(StdioClientTransport).toBeTypeOf("function");
  });

  it.todo("05-08 Task 2 spawns a separate server child with an explicit synthetic config and profile");
  it.todo("05-08 Task 2 initializes an SDK client and lists the complete explicit catalog");
  it.todo("05-08 Task 2 calls source_status successfully while synchronization is offline");
  it.todo("05-08 Task 2 calls a pure read and observes equivalent structured and text disclosure");
  it.todo("05-08 Task 2 rejects startup when profile selection is missing or unknown");
  it.todo("05-08 Task 2 closes cleanly on SDK shutdown, stdin EOF, and abrupt disconnect");
  it.todo("05-08 Task 2 reserves stdout for MCP frames with no diagnostic contamination");
  it.todo("05-08 Task 2 keeps stderr free of fixture content, paths, raw IDs, and titles");
});
