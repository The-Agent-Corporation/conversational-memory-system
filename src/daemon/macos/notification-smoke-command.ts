import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import type { CommandRunner, NotificationAttempt } from "../runtime-adapters.js";
import {
  MacOSNotificationAdapter,
  type DegradedEpisodeNotification
} from "./notification.js";

export const MACOS_NOTIFICATION_SMOKE_EPISODE: Readonly<DegradedEpisodeNotification> = Object.freeze({
  sourceLabel: "synthetic-approved-source",
  category: "permission_denied",
  attemptCount: 3,
  degradedAt: "2000-01-01T00:00:00.000Z"
});

export interface MacOSNotificationSmokeDependencies {
  commandRunner: CommandRunner;
  commandAvailable?: (command: string) => boolean;
  writeOutput?: (value: string) => void;
}

export async function runMacOSNotificationSmoke(
  dependencies: MacOSNotificationSmokeDependencies
): Promise<NotificationAttempt> {
  const adapter = new MacOSNotificationAdapter({
    commandRunner: dependencies.commandRunner,
    commandAvailable: dependencies.commandAvailable
  });
  const attempt = await adapter.notify(MACOS_NOTIFICATION_SMOKE_EPISODE);
  (dependencies.writeOutput ?? ((value) => process.stdout.write(value)))(`${JSON.stringify(attempt, null, 2)}\n`);
  return attempt;
}

class NodeCommandRunner implements CommandRunner {
  run(command: string, args: string[] = []): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    return new Promise((complete) => {
      execFile(command, args, { encoding: "utf8" }, (error, stdout, stderr) => {
        complete({
          exitCode: typeof error?.code === "number" ? error.code : error ? 1 : 0,
          stdout,
          stderr
        });
      });
    });
  }
}

export async function main(argv: string[]): Promise<void> {
  if (argv.length > 0) {
    throw new Error("The notification smoke command accepts no arguments.");
  }
  const attempt = await runMacOSNotificationSmoke({
    commandRunner: new NodeCommandRunner(),
    commandAvailable: (command) => process.platform === "darwin" && existsSync(command)
  });
  if (!attempt.capable || !attempt.commandAccepted) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch(() => {
    process.stderr.write("macOS notification smoke command failed.\n");
    process.exitCode = 1;
  });
}
