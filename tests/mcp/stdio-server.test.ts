import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, describe, expect, it } from "vitest";
import { MEMORY_READ_TOOL_NAMES } from "../../src/mcp/tools/read-tools.js";
import { MEMORY_MUTATION_TOOL_NAMES } from "../../src/mcp/tools/mutation-tools.js";
import { createSyntheticMcpFixture, type SyntheticMcpFixture } from "./fixtures.js";

const ROOT = resolve(import.meta.dirname, "../..");
const TSX = resolve(ROOT, "node_modules/tsx/dist/cli.mjs");
const SERVER = resolve(ROOT, "src/mcp/server-command.ts");
const baseArgs = (fixture: SyntheticMcpFixture, profile = "alpha-expanded") => [
  TSX,
  SERVER,
  "--config",
  fixture.configPath,
  "--profile",
  profile
];
const hostArgs = (fixture: SyntheticMcpFixture) => [
  "--silent",
  "--prefix",
  ROOT,
  "run",
  "memory:mcp",
  "--",
  "--config",
  fixture.configPath,
  "--profile",
  "alpha-expanded"
];
const codexRegistration = (fixture: SyntheticMcpFixture) => ({
  command: "npm",
  args: hostArgs(fixture),
  cwd: ROOT,
  stderr: "pipe" as const,
  env: { NODE_NO_WARNINGS: "1" }
});
const openClawRegistration = (fixture: SyntheticMcpFixture) => ({
  mcpServers: {
    memory: {
      command: "npm",
      args: hostArgs(fixture),
      cwd: ROOT,
      env: { NODE_NO_WARNINGS: "1" }
    }
  }
});

describe("MCP SDK-driven STDIO lifecycle contract", () => {
  let fixture: SyntheticMcpFixture | undefined;
  let client: Client | undefined;
  let transport: StdioClientTransport | undefined;

  afterEach(async () => {
    await client?.close();
    await transport?.close();
    await fixture?.cleanup();
  });

  it("uses the pinned official SDK client and STDIO transport generation", () => {
    expect(Client).toBeTypeOf("function");
    expect(StdioClientTransport).toBeTypeOf("function");
  });

  it("05-08 Task 2 initializes a separate explicit-profile child and lists the complete catalog", async () => {
    fixture = await createSyntheticMcpFixture();
    const registration = codexRegistration(fixture);
    expect(registration.args).toEqual(expect.arrayContaining([
      "--config", fixture.configPath, "--profile", "alpha-expanded"
    ]));
    const stderr: string[] = [];
    const protocolErrors: Error[] = [];
    transport = new StdioClientTransport(registration);
    transport.stderr?.on("data", (chunk) => stderr.push(String(chunk)));
    transport.onerror = (error) => protocolErrors.push(error);
    client = new Client({ name: "synthetic-codex-registration", version: "1.0.0" });

    await client.connect(transport);
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual(
      [...MEMORY_READ_TOOL_NAMES, "memory_inject", ...MEMORY_MUTATION_TOOL_NAMES]
    );
    expect(protocolErrors).toEqual([]);
    expect(stderr.join(""))
      .not.toMatch(/Synthetic alpha|proposal-mixed|person-alpha|memory\.sqlite|profiles\.json/);
  });

  it("05-08 Task 2 supports offline reads and an exact preview-confirmed execute over STDIO", async () => {
    fixture = await createSyntheticMcpFixture();
    const registration = openClawRegistration(fixture);
    expect(registration.mcpServers.memory.args).toEqual(codexRegistration(fixture).args);
    transport = new StdioClientTransport({
      ...registration.mcpServers.memory,
      stderr: "pipe"
    });
    client = new Client({ name: "synthetic-openclaw-registration", version: "1.0.0" });
    await client.connect(transport);

    const [status] = await Promise.all([
      client.callTool({ name: "source_status", arguments: {} }),
      fixture.store.savePerson({
        id: "person-concurrent-writer",
        displayName: "Synthetic Concurrent Writer",
        createdAt: "2026-07-18T12:00:00.000Z"
      })
    ]);
    expect(status.structuredContent).toEqual(expect.objectContaining({
      synchronization: { online: false, state: "stopped" }
    }));
    const read = await client.callTool({
      name: "memory_search",
      arguments: { query: "Synthetic alpha", limit: 20 }
    });
    expect(read.isError).not.toBe(true);
    expect(read.content).toEqual([
      expect.objectContaining({ type: "text", text: expect.stringContaining(JSON.stringify(read.structuredContent, null, 2)) })
    ]);

    const preview = await client.callTool({
      name: "proposal_reject_preview",
      arguments: {
        proposalId: "proposal-mixed",
        decidedAt: "2026-07-18T12:01:00.000Z",
        reviewer: "synthetic-reviewer"
      }
    });
    const token = (preview.structuredContent as { token?: string } | undefined)?.token;
    expect(token).toBeTypeOf("string");
    const execute = await client.callTool({
      name: "proposal_reject_execute",
      arguments: {
        proposalId: "proposal-mixed",
        decidedAt: "2026-07-18T12:01:00.000Z",
        reviewer: "synthetic-reviewer",
        token
      }
    });
    expect(execute.structuredContent).toEqual(expect.objectContaining({ status: "COMMITTED" }));
  });

  it("05-08 Task 2 rejects missing or unknown profile authority before protocol startup", async () => {
    fixture = await createSyntheticMcpFixture();
    const missing = await runRejected([TSX, SERVER]);
    const unknown = await runRejected(baseArgs(fixture, "unknown-profile"));

    for (const result of [missing, unknown]) {
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("MEMORY_MCP_STARTUP_FAILED\n");
      expect(result.stderr).not.toContain(fixture.tempDir);
    }
  });

  it("05-08 Task 2 emits only parseable MCP frames and closes cleanly on stdin EOF", async () => {
    fixture = await createSyntheticMcpFixture();
    const child = spawn(process.execPath, baseArgs(fixture), {
      cwd: ROOT,
      env: { ...process.env, NODE_NO_WARNINGS: "1" },
      stdio: ["pipe", "pipe", "pipe"]
    });
    const stdout: string[] = [];
    const stderr: string[] = [];
    child.stdout.on("data", (chunk) => stdout.push(String(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(String(chunk)));
    child.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "synthetic-hermes-sdk", version: "1.0.0" }
      }
    })}\n`);
    await waitFor(() => stdout.join("").includes("\n"));
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`);
    await waitFor(() => stdout.join("").trim().split("\n").length >= 2);
    child.stdin.end();
    const code = await new Promise<number | null>((resolveExit) => child.once("close", resolveExit));

    const frames = stdout.join("").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    expect(frames).toHaveLength(2);
    expect(frames.map((frame) => frame.id)).toEqual([1, 2]);
    expect(code).toBe(0);
    expect(stderr.join(""))
      .not.toMatch(/Synthetic alpha|proposal-mixed|person-alpha|memory\.sqlite|profiles\.json/);
  });
});

const runRejected = async (args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> => {
  const child = spawn(process.execPath, args, {
    cwd: ROOT,
    env: { ...process.env, NODE_NO_WARNINGS: "1" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const stdout: string[] = [];
  const stderr: string[] = [];
  child.stdout.on("data", (chunk) => stdout.push(String(chunk)));
  child.stderr.on("data", (chunk) => stderr.push(String(chunk)));
  const code = await new Promise<number | null>((resolveExit) => child.once("close", resolveExit));
  return { code, stdout: stdout.join(""), stderr: stderr.join("") };
};

const waitFor = async (predicate: () => boolean): Promise<void> => {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for synthetic MCP frame");
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
};
