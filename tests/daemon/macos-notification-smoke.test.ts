import { describe, expect, it } from "vitest";
import {
  MACOS_NOTIFICATION_SMOKE_EPISODE,
  runMacOSNotificationSmoke
} from "../../src/daemon/macos/notification-smoke-command.js";
import { MACOS_NOTIFICATION_IDENTITY } from "../../src/daemon/macos/notification.js";
import { FakeCommandRunner } from "./fixtures.js";

describe("macOS notification smoke command", () => {
  it("invokes the production adapter once with a fixed synthetic episode and prints acceptance", async () => {
    const commands = new FakeCommandRunner();
    commands.enqueueResult({ exitCode: 0 });
    const output: string[] = [];

    const attempt = await runMacOSNotificationSmoke({
      commandRunner: commands,
      commandAvailable: () => true,
      writeOutput: (value) => output.push(value)
    });

    expect(attempt).toEqual({
      capable: true,
      commandAccepted: true,
      presentation: "unverified",
      identity: MACOS_NOTIFICATION_IDENTITY
    });
    expect(commands.calls).toHaveLength(1);
    expect(commands.calls[0]).toMatchObject({ command: "/usr/bin/osascript" });
    expect(commands.calls[0]?.args.join(" ")).toContain(MACOS_NOTIFICATION_SMOKE_EPISODE.sourceLabel);
    expect(JSON.parse(output.join(""))).toEqual(attempt);
  });

  it.each([
    ["rejected", true, 1],
    ["unavailable", false, 0]
  ] as const)("prints a truthful unverified receipt when the command is %s", async (_case, available, exitCode) => {
    const commands = new FakeCommandRunner();
    commands.enqueueResult({ exitCode });
    const output: string[] = [];

    const attempt = await runMacOSNotificationSmoke({
      commandRunner: commands,
      commandAvailable: () => available,
      writeOutput: (value) => output.push(value)
    });

    expect(attempt).toMatchObject({
      capable: available,
      commandAccepted: false,
      presentation: "unverified",
      identity: MACOS_NOTIFICATION_IDENTITY
    });
    expect(commands.calls).toHaveLength(available ? 1 : 0);
    expect(JSON.parse(output.join(""))).toEqual(attempt);
  });

  it("has no arbitrary content input and emits only synthetic operational metadata", async () => {
    const commands = new FakeCommandRunner();
    const output: string[] = [];
    await runMacOSNotificationSmoke({
      commandRunner: commands,
      commandAvailable: () => true,
      writeOutput: (value) => output.push(value)
    });

    const serialized = JSON.stringify({ calls: commands.calls, output });
    expect(MACOS_NOTIFICATION_SMOKE_EPISODE).toEqual({
      sourceLabel: "synthetic-approved-source",
      category: "permission_denied",
      attemptCount: 3,
      degradedAt: "2000-01-01T00:00:00.000Z"
    });
    expect(serialized).not.toMatch(
      /conversation body|native path|sourcePath|exception|tool result|credential|api[_-]?key|personId|workspaceId|transcript|secret/i
    );
  });
});
