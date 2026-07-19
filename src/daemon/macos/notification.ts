import type {
  CommandRunner,
  DaemonNotification,
  NotificationApplicationIdentity,
  NotificationAttempt
} from "../runtime-adapters.js";
import type { DaemonErrorCategory } from "../types.js";

export const MACOS_NOTIFICATION_IDENTITY: NotificationApplicationIdentity = Object.freeze({
  displayName: "Script Editor",
  bundleIdentifier: "com.apple.ScriptEditor2"
});

export interface DegradedEpisodeNotification {
  sourceLabel: string;
  category: DaemonErrorCategory;
  attemptCount: number;
  degradedAt: string;
}

export class MacOSNotificationAdapter {
  constructor(private readonly options: {
    commandRunner: CommandRunner;
    commandAvailable?: (command: string) => boolean;
  }) {}

  async notify(input: DegradedEpisodeNotification | DaemonNotification): Promise<NotificationAttempt> {
    if (!(this.options.commandAvailable?.("/usr/bin/osascript") ?? process.platform === "darwin")) {
      return attempt(false, false);
    }
    const episode = "sourceLabel" in input
      ? input
      : { sourceLabel: input.sourceId ?? "configured-source", category: "unknown" as const, attemptCount: 0, degradedAt: "" };
    const title = "Conversational Memory";
    const category = safe(episode.category, 40);
    const attemptCount = Math.max(0, Math.min(999, Number.isFinite(episode.attemptCount)
      ? Math.trunc(episode.attemptCount)
      : 0));
    const body = `Source ${safe(episode.sourceLabel, 120)} is degraded (${category}, attempt ${attemptCount}).`;
    const script = `display notification "${apple(body)}" with title "${apple(title)}"`;
    try {
      const result = await this.options.commandRunner.run("/usr/bin/osascript", ["-e", script]);
      return attempt(true, result.exitCode === 0);
    } catch {
      return attempt(true, false);
    }
  }
}

function attempt(capable: boolean, commandAccepted: boolean): NotificationAttempt {
  return {
    capable,
    commandAccepted,
    presentation: "unverified",
    identity: MACOS_NOTIFICATION_IDENTITY
  };
}

function safe(value: string, maximumLength: number): string {
  return value.replace(/[^A-Za-z0-9._:-]/g, "_").slice(0, maximumLength) || "configured-source";
}

function apple(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}
