import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMemoryMcpServer } from "../../mcp/server.js";

export interface HermesMcpTarget {
  readonly configPath: string;
  readonly profileName: string;
}

export interface MemoryToolCallResult {
  readonly isError: boolean;
  readonly structuredContent: Record<string, unknown> | null;
  readonly text: string;
}

/**
 * Hermes talks to memory as an ordinary local MCP client. The profile, not the
 * command, owns person and scope.
 */
export async function callHermesMemoryTool(
  target: HermesMcpTarget,
  name: string,
  args: Record<string, unknown>
): Promise<MemoryToolCallResult> {
  const application = await createMemoryMcpServer({
    configPath: target.configPath,
    profileName: target.profileName
  });
  const client = new Client({ name: "hermes-mcp-wrapper", version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await application.server.connect(serverTransport);
    await client.connect(clientTransport);
    const result = await client.callTool({ name, arguments: args });
    const content = Array.isArray(result.content) ? result.content : [];
    const text = content
      .map((item) => {
        if (item && typeof item === "object" && "text" in item && typeof item.text === "string") return item.text;
        return "";
      })
      .join("\n");
    return {
      isError: result.isError === true,
      structuredContent: isRecord(result.structuredContent) ? result.structuredContent : null,
      text
    };
  } finally {
    await client.close();
    await application.close();
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
