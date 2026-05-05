import type { HostEvent } from "../domain/events.js";
import type { InjectionPacket } from "../domain/types.js";

export interface HostAdapter {
  readonly host: string;
  readEvents(sinceSequence: number): Promise<HostEvent[]>;
  writeInjection(packet: InjectionPacket): Promise<void>;
  acknowledgeInjection(packetId: string): Promise<void>;
  reportApproval(decision: HostApprovalDecision): Promise<void>;
}

export interface HostApprovalDecision {
  id: string;
  host: string;
  profileId: string;
  hostSessionId: string;
  proposalId: string;
  decision: "approved" | "rejected";
  reason: string | null;
  decidedAt: string;
}
