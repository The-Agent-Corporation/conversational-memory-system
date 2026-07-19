import { z } from "zod";
import { IsoDateTimeSchema, TurnRangeSchema } from "../domain/types.js";

export const RollingTopicCheckpointSchema = z.object({
  host: z.string().min(1),
  profileId: z.string().min(1),
  hostSessionId: z.string().min(1),
  topicLabel: z.string().min(1),
  currentTopicSummary: z.string().min(1),
  sourceTurnRange: TurnRangeSchema,
  turnCount: z.number().int().positive(),
  lastEventId: z.string().min(1),
  updatedAt: IsoDateTimeSchema
});

export const HistoricalBootstrapCheckpointSchema = z.object({
  id: z.string().min(1),
  personId: z.string().min(1),
  processorVersion: z.string().min(1),
  processedEventCount: z.number().int().nonnegative(),
  lastCanonicalEventId: z.string().min(1).nullable(),
  rollingPrefixHash: z.string(),
  activeTopic: RollingTopicCheckpointSchema.nullable(),
  updatedAt: IsoDateTimeSchema
});

export interface HistoricalBootstrapResult {
  reset: boolean;
  eventsProcessed: number;
  summariesUpdated: number;
  anchorsDetected: number;
  boxProposalsCreated: number;
  traceProposalsCreated: number;
  checkpoint: HistoricalBootstrapCheckpoint;
}

export type HistoricalBootstrapCheckpoint = z.infer<
  typeof HistoricalBootstrapCheckpointSchema
>;
