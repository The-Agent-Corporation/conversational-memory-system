import type {
  Anchor,
  Box,
  InjectionPacket,
  MemoryProposal,
  MemoryTrace,
  ProposalState,
  ProposalType,
  Summary,
  Turn
} from "../domain/types.js";

export interface ProposalFilter {
  state?: ProposalState;
  proposalType?: ProposalType;
}

export interface TraceFilter {
  state?: ProposalState;
}

export interface MemoryStore {
  saveTurn(turn: Turn): Promise<void>;
  listTurns(threadId: string): Promise<Turn[]>;
  saveSummary(summary: Summary): Promise<void>;
  listSummaries(): Promise<Summary[]>;
  saveBox(box: Box): Promise<void>;
  getBox(id: string): Promise<Box | null>;
  listBoxes(): Promise<Box[]>;
  saveAnchor(anchor: Anchor): Promise<void>;
  listAnchors(): Promise<Anchor[]>;
  saveInjection(packet: InjectionPacket): Promise<void>;
  listInjections(hostSessionId: string): Promise<InjectionPacket[]>;
  saveProposal(proposal: MemoryProposal): Promise<void>;
  getProposal(id: string): Promise<MemoryProposal | null>;
  listProposals(filter?: ProposalFilter): Promise<MemoryProposal[]>;
  saveTrace(trace: MemoryTrace): Promise<void>;
  getTrace(id: string): Promise<MemoryTrace | null>;
  listTraces(filter?: TraceFilter): Promise<MemoryTrace[]>;
}
