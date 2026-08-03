import { access, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { CommandRunner } from "../runtime-adapters.js";

export const DEFAULT_LAUNCH_AGENT_LABEL = "com.conversational-memory.daemon";

export interface LaunchAgentOptions {
  databasePath: string;
  repositoryRoot: string;
  plistPath: string;
  stdoutPath: string;
  stderrPath: string;
  commandRunner: CommandRunner;
  userDomain: string;
  commandAvailable?: (command: string) => boolean;
}

export interface LaunchAgentStatus {
  capable: boolean;
  loaded: boolean;
  pid: number | null;
}

type PlistOptions = Pick<LaunchAgentOptions,
  "databasePath" | "repositoryRoot" | "plistPath" | "stdoutPath" | "stderrPath"> & {
    /** The node binary to run under. Defaults to the interpreter generating the plist. */
    nodePath?: string;
  };

export function generateLaunchAgentPlist(options: PlistOptions): string {
  const repositoryRoot = resolve(options.repositoryRoot);
  // Invoke node DIRECTLY, by absolute path, rather than `node_modules/.bin/tsx`.
  //
  // That wrapper is a `#!/usr/bin/env node` script, and launchd does not run jobs with a login
  // shell: its PATH is the bare system default, with no /opt/homebrew/bin and no nvm shim. A
  // Homebrew or nvm node is therefore invisible, `env` fails to resolve it, and the job dies with
  // `env: node: No such file or directory` -- exit 127. `KeepAlive` then respawns it immediately,
  // so the failure presents as a service that reports `loaded: true` while never running and
  // silently burning restarts. Observed exactly that on this machine.
  //
  // `process.execPath` is the interpreter that ran `memory daemon start`, so the daemon runs under
  // the same node the CLI did, with no PATH dependency at all.
  const nodePath = options.nodePath ?? process.execPath;
  const argv = [
    nodePath,
    join(repositoryRoot, "node_modules/tsx/dist/cli.mjs"),
    join(repositoryRoot, "src/daemon/daemon-command.ts"),
    "run",
    "--db",
    resolve(options.databasePath)
  ];
  const argumentsXml = argv.map((value) => `      <string>${xml(value)}</string>`).join("\n");
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  <string>${DEFAULT_LAUNCH_AGENT_LABEL}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    argumentsXml,
    '  </array>',
    '  <key>RunAtLoad</key>',
    '  <true/>',
    '  <key>KeepAlive</key>',
    '  <true/>',
    '  <key>StandardOutPath</key>',
    `  <string>${xml(resolve(options.stdoutPath))}</string>`,
    '  <key>StandardErrorPath</key>',
    `  <string>${xml(resolve(options.stderrPath))}</string>`,
    '</dict>',
    '</plist>',
    ''
  ].join("\n");
}

export class MacOSLaunchAgent {
  constructor(private readonly options: LaunchAgentOptions) {}

  async status(): Promise<LaunchAgentStatus> {
    if (!this.capable()) return { capable: false, loaded: false, pid: null };
    const result = await this.options.commandRunner.run("/bin/launchctl", [
      "print", `${this.options.userDomain}/${DEFAULT_LAUNCH_AGENT_LABEL}`
    ]);
    if (result.exitCode !== 0) return { capable: true, loaded: false, pid: null };
    const match = result.stdout.match(/\bpid\s*=\s*(\d+)/i);
    return { capable: true, loaded: true, pid: match ? Number(match[1]) : null };
  }

  async start(): Promise<LaunchAgentStatus> {
    if (!this.capable()) return { capable: false, loaded: false, pid: null };
    await mkdir(dirname(this.options.plistPath), { recursive: true });
    await writeFile(this.options.plistPath, generateLaunchAgentPlist(this.options), { encoding: "utf8", mode: 0o600 });
    const result = await this.options.commandRunner.run("/bin/launchctl", [
      "bootstrap", this.options.userDomain, this.options.plistPath
    ]);
    return { capable: true, loaded: result.exitCode === 0, pid: null };
  }

  async stop(): Promise<LaunchAgentStatus> {
    if (!this.capable()) return { capable: false, loaded: false, pid: null };
    await this.options.commandRunner.run("/bin/launchctl", [
      "bootout", this.options.userDomain, this.options.plistPath
    ]);
    await rm(this.options.plistPath, { force: true });
    return { capable: true, loaded: false, pid: null };
  }

  private capable(): boolean {
    return this.options.commandAvailable?.("/bin/launchctl") ?? process.platform === "darwin";
  }
}

export async function pathExists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

function xml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}
