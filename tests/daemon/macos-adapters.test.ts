import { mkdtemp, readFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_LAUNCH_AGENT_LABEL,
  MacOSLaunchAgent,
  generateLaunchAgentPlist
} from "../../src/daemon/macos/launch-agent.js";
import {
  MACOS_NOTIFICATION_IDENTITY,
  MacOSNotificationAdapter
} from "../../src/daemon/macos/notification.js";
import {
  MacOSPowerSource,
  parsePmsetPowerState
} from "../../src/daemon/macos/power-source.js";
import { FakeCommandRunner } from "./fixtures.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("MacOSLaunchAgent", () => {
  it("ships a fail-closed disposable live-UAT script", async () => {
    const scriptPath = join(process.cwd(), "scripts", "macos-launch-agent-uat.zsh");
    const script = await readFile(scriptPath, "utf8");
    const syntax = spawnSync("/bin/zsh", ["-n", scriptPath], { encoding: "utf8" });

    expect(syntax.status).toBe(0);
    expect(script.indexOf('launchctl print "$user_domain/$service_label"'))
      .toBeLessThan(script.indexOf("memory:daemon -- start"));
    expect(script.indexOf('[[ -e "$plist_path" ]]'))
      .toBeLessThan(script.indexOf("memory:daemon -- start"));
    expect(script).toContain("mktemp -d /tmp/cms-launch-agent-uat.XXXXXX");
    expect(script).toContain('memory:daemon -- status --db "$database_path"');
    expect(script).toContain('memory:daemon -- stop --db "$database_path"');
    expect(script).toContain('launchctl bootout "$user_domain" "$plist_path"');
    expect(script).toContain('[[ -e "$plist_path" ]]');
    expect(script).not.toMatch(/codex:discover|claude:discover|openclaw:discover|hermes:discover|:import/);
  });

  it("generates a deterministic escaped plist with only the expected daemon arguments", () => {
    const options = {
      databasePath: "/tmp/memory & private.sqlite",
      repositoryRoot: "/tmp/repository <memory>",
      plistPath: "/tmp/com.conversational-memory.daemon.plist",
      stdoutPath: "/tmp/memory-daemon.out.log",
      stderrPath: "/tmp/memory-daemon.err.log"
    };

    const first = generateLaunchAgentPlist(options);
    const second = generateLaunchAgentPlist(options);

    expect(first).toBe(second);
    expect(first).toContain(`<string>${DEFAULT_LAUNCH_AGENT_LABEL}</string>`);
    expect(first).toContain("/tmp/repository &lt;memory&gt;/node_modules/tsx/dist/cli.mjs");
    expect(first).toContain("/tmp/repository &lt;memory&gt;/src/daemon/daemon-command.ts");
    expect(first).toContain("<string>run</string>");
    expect(first).toContain("<string>--db</string>");
    expect(first).toContain("/tmp/memory &amp; private.sqlite");
    expect(first).not.toMatch(/transcript|password|api[_-]?key/i);
  });

  /**
   * launchd does not run jobs with a login shell: PATH is the bare system default, with no
   * /opt/homebrew/bin and no nvm shim. A `#!/usr/bin/env node` wrapper therefore cannot resolve a
   * Homebrew or nvm node and the job dies with exit 127 -- and because `KeepAlive` is true, it
   * respawns immediately, so the service reports `loaded: true` while never once running.
   *
   * Observed on a real machine: `memory daemon start` returned `{ ok: true, loaded: true }` and the
   * daemon log filled with `env: node: No such file or directory`.
   */
  it("runs node by absolute path so launchd's minimal PATH cannot break it", () => {
    const plist = generateLaunchAgentPlist({
      databasePath: "/tmp/memory.sqlite",
      repositoryRoot: "/tmp/repository",
      plistPath: "/tmp/com.conversational-memory.daemon.plist",
      stdoutPath: "/tmp/out.log",
      stderrPath: "/tmp/err.log",
      nodePath: "/opt/homebrew/bin/node"
    });

    // The interpreter is the FIRST argument, so launchd execs it directly rather than resolving a
    // shebang against its own PATH.
    const firstArgument = plist.match(/<array>\s*<string>([^<]+)<\/string>/)?.[1];
    expect(firstArgument).toBe("/opt/homebrew/bin/node");
    expect(plist).not.toContain("node_modules/.bin/tsx");
  });

  it("defaults to the interpreter that generated the plist", () => {
    // So the daemon runs under the same node as the CLI that started it, whatever that is.
    const plist = generateLaunchAgentPlist({
      databasePath: "/tmp/memory.sqlite",
      repositoryRoot: "/tmp/repository",
      plistPath: "/tmp/com.conversational-memory.daemon.plist",
      stdoutPath: "/tmp/out.log",
      stderrPath: "/tmp/err.log"
    });

    expect(plist.match(/<array>\s*<string>([^<]+)<\/string>/)?.[1]).toBe(process.execPath);
  });

  it("writes and bootstraps only on explicit start, while status is read-only", async () => {
    const directory = await mkdtemp(join(tmpdir(), "daemon-launch-agent-"));
    cleanup.push(directory);
    const commands = new FakeCommandRunner();
    commands.enqueueResult({ exitCode: 3, stderr: "service not found" });
    commands.enqueueResult({ stdout: "" });
    const plistPath = join(directory, `${DEFAULT_LAUNCH_AGENT_LABEL}.plist`);
    const launchAgent = new MacOSLaunchAgent({
      databasePath: join(directory, "memory.sqlite"),
      repositoryRoot: directory,
      plistPath,
      stdoutPath: join(directory, "daemon.out.log"),
      stderrPath: join(directory, "daemon.err.log"),
      commandRunner: commands,
      userDomain: "gui/501"
    });

    await expect(launchAgent.status()).resolves.toMatchObject({ capable: true, loaded: false });
    await expect(readFile(plistPath, "utf8")).rejects.toThrow();
    expect(commands.calls).toEqual([{
      command: "/bin/launchctl",
      args: ["print", `gui/501/${DEFAULT_LAUNCH_AGENT_LABEL}`]
    }]);

    await expect(launchAgent.start()).resolves.toMatchObject({ capable: true, loaded: true });
    expect(await readFile(plistPath, "utf8")).toBe(generateLaunchAgentPlist({
      databasePath: join(directory, "memory.sqlite"),
      repositoryRoot: directory,
      plistPath,
      stdoutPath: join(directory, "daemon.out.log"),
      stderrPath: join(directory, "daemon.err.log")
    }));
    expect(commands.calls.at(-1)).toEqual({
      command: "/bin/launchctl",
      args: ["bootstrap", "gui/501", plistPath]
    });
    expect(plistPath).not.toContain("Library/LaunchAgents");

    await expect(launchAgent.stop()).resolves.toMatchObject({ capable: true, loaded: false });
    expect(commands.calls.at(-1)).toEqual({
      command: "/bin/launchctl",
      args: ["bootout", "gui/501", plistPath]
    });
    await expect(readFile(plistPath, "utf8")).rejects.toThrow();
  });

  it("reports absent service capability without writing a plist or throwing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "daemon-no-launchctl-"));
    cleanup.push(directory);
    const commands = new FakeCommandRunner();
    const plistPath = join(directory, "daemon.plist");
    const launchAgent = new MacOSLaunchAgent({
      databasePath: join(directory, "memory.sqlite"),
      repositoryRoot: directory,
      plistPath,
      stdoutPath: join(directory, "out.log"),
      stderrPath: join(directory, "err.log"),
      commandRunner: commands,
      userDomain: "gui/501",
      commandAvailable: () => false
    });

    await expect(launchAgent.status()).resolves.toEqual({ capable: false, loaded: false, pid: null });
    await expect(launchAgent.start()).resolves.toMatchObject({ capable: false, loaded: false });
    await expect(readFile(plistPath, "utf8")).rejects.toThrow();
    expect(commands.calls).toEqual([]);
  });
});

describe("MacOSPowerSource", () => {
  it.each([
    ["Now drawing from 'AC Power'\n", "external"],
    ["Now drawing from 'Battery Power'\n", "battery"],
    ["unexpected output", "unknown"],
    ["", "unknown"]
  ] as const)("maps pmset fixture output %j to %s", (output, expected) => {
    expect(parsePmsetPowerState(output)).toBe(expected);
  });

  it("uses only the injected command runner and degrades failures to unknown", async () => {
    const commands = new FakeCommandRunner();
    commands.enqueueResult({ stdout: "Now drawing from 'Battery Power'" });
    commands.enqueueResult({ exitCode: 1, stderr: "unavailable" });
    const power = new MacOSPowerSource({ commandRunner: commands });

    await expect(power.current()).resolves.toBe("battery");
    await expect(power.current()).resolves.toBe("unknown");
    expect(commands.calls).toEqual([
      { command: "/usr/bin/pmset", args: ["-g", "batt"] },
      { command: "/usr/bin/pmset", args: ["-g", "batt"] }
    ]);
  });
});

describe("MacOSNotificationAdapter", () => {
  it("reports command acceptance without claiming Notification Center presentation", async () => {
    const commands = new FakeCommandRunner();
    commands.enqueueResult({ exitCode: 0 });
    commands.enqueueResult({ exitCode: 1, stderr: "osascript failed" });
    const notifications = new MacOSNotificationAdapter({ commandRunner: commands });
    const episode = {
      sourceLabel: "codex_candidate_synthetic",
      category: "permission_denied" as const,
      attemptCount: 3,
      degradedAt: "2026-07-17T12:00:00.000Z"
    };

    await expect(notifications.notify(episode)).resolves.toEqual({
      capable: true,
      commandAccepted: true,
      presentation: "unverified",
      identity: MACOS_NOTIFICATION_IDENTITY
    });
    await expect(notifications.notify({ ...episode, degradedAt: "2026-07-17T13:00:00.000Z" }))
      .resolves.toEqual({
        capable: true,
        commandAccepted: false,
        presentation: "unverified",
        identity: MACOS_NOTIFICATION_IDENTITY
      });
    expect(MACOS_NOTIFICATION_IDENTITY).toEqual({
      displayName: "Script Editor",
      bundleIdentifier: "com.apple.ScriptEditor2"
    });
    expect(commands.calls).toHaveLength(2);
    expect(commands.calls.every((call) => call.command === "/usr/bin/osascript")).toBe(true);
    const serialized = JSON.stringify(commands.calls);
    expect(serialized).toContain("codex_candidate_synthetic");
    expect(serialized).toContain("permission_denied");
    expect(serialized).toContain("attempt 3");
    expect(serialized).not.toMatch(/delivered|presented|transcript|secret|password|api[_-]?key/i);
  });

  it("contains only bounded controlled fields and ignores private extra data", async () => {
    const commands = new FakeCommandRunner();
    const notifications = new MacOSNotificationAdapter({ commandRunner: commands, commandAvailable: () => true });
    await notifications.notify({
      sourceLabel: `source-\"\\${"x".repeat(180)}`,
      category: "permission_denied",
      attemptCount: 99_999,
      degradedAt: "2026-07-17T12:00:00.000Z",
      transcript: "private conversation",
      sourcePath: "/Users/private/history.jsonl",
      exception: "password=hunter2",
      toolResult: "API_KEY=secret",
      personId: "person-private",
      workspaceId: "case-private"
    } as never);

    const serialized = JSON.stringify(commands.calls);
    expect(serialized).not.toMatch(/private conversation|Users.private|hunter2|API_KEY|person-private|case-private/i);
    expect(serialized.length).toBeLessThan(500);
  });

  it("treats rejected, thrown, and missing notification capability as non-fatal", async () => {
    const commands = new FakeCommandRunner();
    commands.enqueueError(new Error("raw exception with secret"));
    const available = new MacOSNotificationAdapter({
      commandRunner: commands,
      commandAvailable: () => true
    });
    await expect(available.notify({
      sourceLabel: "source-a",
      category: "unknown",
      attemptCount: 3,
      degradedAt: "2026-07-17T12:00:00.000Z"
    })).resolves.toEqual({
      capable: true,
      commandAccepted: false,
      presentation: "unverified",
      identity: MACOS_NOTIFICATION_IDENTITY
    });

    const notifications = new MacOSNotificationAdapter({
      commandRunner: commands,
      commandAvailable: () => false
    });
    await expect(notifications.notify({
      sourceLabel: "source-a",
      category: "unknown",
      attemptCount: 3,
      degradedAt: "2026-07-17T12:00:00.000Z"
    })).resolves.toEqual({
      capable: false,
      commandAccepted: false,
      presentation: "unverified",
      identity: MACOS_NOTIFICATION_IDENTITY
    });
    expect(commands.calls).toHaveLength(1);
  });
});
