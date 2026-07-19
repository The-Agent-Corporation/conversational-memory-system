import type { CommandRunner, PowerState, PowerStateProvider } from "../runtime-adapters.js";

export interface MacOSPowerSourceOptions {
  commandRunner: CommandRunner;
  commandAvailable?: (command: string) => boolean;
}

export function parsePmsetPowerState(output: string): PowerState {
  if (/['\"]AC Power['\"]/i.test(output)) return "external";
  if (/['\"]Battery Power['\"]/i.test(output)) return "battery";
  return "unknown";
}

export class MacOSPowerSource implements PowerStateProvider {
  constructor(private readonly options: MacOSPowerSourceOptions) {}

  async current(): Promise<PowerState> {
    if (!(this.options.commandAvailable?.("/usr/bin/pmset") ?? process.platform === "darwin")) return "unknown";
    try {
      const result = await this.options.commandRunner.run("/usr/bin/pmset", ["-g", "batt"]);
      return result.exitCode === 0 ? parsePmsetPowerState(result.stdout) : "unknown";
    } catch {
      return "unknown";
    }
  }

  getPowerState(): Promise<PowerState> {
    return this.current();
  }
}
