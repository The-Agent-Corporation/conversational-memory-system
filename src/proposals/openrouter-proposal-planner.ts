import { z } from "zod";
import type {
  Anchor,
  Box,
  MemoryProposal,
  MemoryTrace,
  ProposalType,
  Summary
} from "../domain/types.js";
import {
  BoxProposalPayloadSchema,
  ParentChildProposalPayloadSchema,
  TraceProposalPayloadSchema
} from "../domain/types.js";
import type {
  BoxProposalPlanner,
  BoxProposalPlanningRequest,
  BoxProposalPlanningResult
} from "../boxes/box-proposal-planner.js";
import type {
  TraceProposalPlanner,
  TraceProposalPlanningRequest,
  TraceProposalPlanningResult
} from "../traces/trace-proposal-planner.js";
import { OpenRouterClient, type FetchLike as ClientFetch } from "../openrouter/client.js";
import { OpenRouterRequestError } from "../openrouter/types.js";
import { dedupeTurnRanges, hasExistingProposal, slugify } from "./proposal-utils.js";

export interface FetchResponseLike {
  ok: boolean;
  status: number;
  statusText?: string;
  text(): Promise<string>;
}

export type FetchLike = (
  url: string,
  init: {
    method: "POST";
    headers: Record<string, string>;
    body: string;
  }
) => Promise<FetchResponseLike>;

export interface OpenRouterProposalPlannerOptions {
  apiKey?: string;
  model: string;
  endpoint?: string;
  baseUrl?: string;
  referer?: string;
  title?: string;
  fetch?: FetchLike | ClientFetch;
  dailySpendCapUsd?: number;
  ledger?: import("../openrouter/types.js").OpenRouterLedger;
}

export type OpenRouterProposalPlannerEnvironment = Partial<Record<
  "OPENROUTER_API_KEY" | "OPENROUTER_MODEL" | "OPENROUTER_BASE_URL" | "OPENROUTER_REFERER" | "OPENROUTER_TITLE",
  string | undefined
>>;

export class OpenRouterProposalPlannerError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly responseText?: string
  ) {
    super(message);
    this.name = "OpenRouterProposalPlannerError";
  }
}

const PROMPT_VERSION = "openrouter-proposal-planner-v2";

export const PERSONAL_AGENT_PLANNER_PROMPT = [
  "You are a background memory organization reviewer for a personal agent's source-linked memory.",
  "Return JSON only with optional arrays boxProposals, parentChildProposals, and traceProposals.",
  "Never approve proposals. Never invent summary ids or box ids. Prefer no proposal over weak organization.",
  "Group memories by what the person is actually working on: decisions, preferences, projects, commitments.",
  "When a specialized domain is present, preserve its exact terms, including legal distinctions such as PIP versus BI and case versus sub-issue."
].join(" ");

const ModelBoxProposalSchema = z.object({
  boxId: z.string().min(1).optional(),
  title: z.string().min(1),
  description: z.string(),
  summary: z.string().min(1),
  boxType: z.enum(["case", "topic", "general", "project", "person"]).default("topic"),
  candidateParentBoxId: z.string().min(1).nullable().optional(),
  keywords: z.array(z.string().min(1)).min(1),
  evidence: z.array(z.string().min(1)).min(1),
  sourceSummaryIds: z.array(z.string().min(1)).min(1),
  confidence: z.number().min(0).max(1),
  rationale: z.string().min(1)
});

const ModelParentChildProposalSchema = z.object({
  parentBoxId: z.string().min(1),
  childBoxId: z.string().min(1),
  relationshipLabel: z.string().min(1),
  rationale: z.string().min(1),
  sourceSummaryIds: z.array(z.string().min(1)).min(1),
  confidence: z.number().min(0).max(1)
});

const ModelTraceProposalSchema = z.object({
  traceId: z.string().min(1).optional(),
  title: z.string().min(1),
  description: z.string(),
  traceType: z.enum(["case_issue", "task_thread", "strategy_thread", "fact_development", "follow_up"]),
  summaryIds: z.array(z.string().min(1)).min(2),
  boxIds: z.array(z.string().min(1)),
  continuityReason: z.string().min(1),
  boundaryReason: z.string().min(1),
  keywords: z.array(z.string().min(1)).min(1),
  confidence: z.number().min(0).max(1),
  rationale: z.string().min(1)
});

const PlannerOutputSchema = z.object({
  boxProposals: z.array(ModelBoxProposalSchema).optional().default([]),
  parentChildProposals: z.array(ModelParentChildProposalSchema).optional().default([]),
  traceProposals: z.array(ModelTraceProposalSchema).optional().default([])
});

type PlannerOutput = z.infer<typeof PlannerOutputSchema>;

export class OpenRouterProposalPlanner implements BoxProposalPlanner, TraceProposalPlanner {
  readonly providerModel: string;
  private readonly client: OpenRouterClient;

  constructor(options: OpenRouterProposalPlannerOptions) {
    if (!options.model.trim()) {
      throw new OpenRouterProposalPlannerError("OpenRouter model is required.");
    }
    this.providerModel = options.model;
    this.client = new OpenRouterClient({
      apiKey: options.apiKey,
      baseUrl: options.baseUrl,
      chatEndpoint: options.endpoint,
      referer: options.referer,
      title: options.title,
      fetch: options.fetch as ClientFetch | undefined,
      dailySpendCapUsd: options.dailySpendCapUsd,
      ledger: options.ledger
    });
  }

  static fromEnv(
    env: OpenRouterProposalPlannerEnvironment = process.env,
    overrides: Partial<Omit<OpenRouterProposalPlannerOptions, "apiKey" | "model">> = {}
  ): OpenRouterProposalPlanner {
    return new OpenRouterProposalPlanner({
      apiKey: env.OPENROUTER_API_KEY ?? "",
      model: env.OPENROUTER_MODEL ?? "",
      baseUrl: env.OPENROUTER_BASE_URL,
      referer: env.OPENROUTER_REFERER,
      title: env.OPENROUTER_TITLE,
      ...overrides
    });
  }

  async proposeBoxes(request: BoxProposalPlanningRequest): Promise<BoxProposalPlanningResult> {
    const output = await this.requestPlannerOutput("box", request);
    const summariesById = new Map(request.summaries.map((summary) => [summary.id, summary]));
    const knownBoxIds = new Set(request.boxes.map((box) => box.id));
    const proposedBoxIds = new Set(output.boxProposals.map((proposal) => proposal.boxId ?? boxIdFromTitle(proposal.title)));
    const proposals: MemoryProposal[] = [];

    for (const modelProposal of output.boxProposals) {
      assertKnownSummaryIds(modelProposal.sourceSummaryIds, summariesById);
      const boxId = modelProposal.boxId ?? boxIdFromTitle(modelProposal.title);
      const proposalId = `proposal_box_${boxId}`;
      if (hasExistingProposal(request.proposals, proposalId) || request.boxes.some((box) => box.id === boxId && box.state !== "rejected")) {
        continue;
      }

      const sourceSummaries = modelProposal.sourceSummaryIds.map((summaryId) => summariesById.get(summaryId)!);
      const sourceTurnRanges = dedupeTurnRanges(sourceSummaries.flatMap((summary) => summary.sourceTurnRanges));
      const payload = BoxProposalPayloadSchema.parse({
        boxId,
        title: modelProposal.title,
        description: modelProposal.description,
        summary: modelProposal.summary,
        boxType: modelProposal.boxType,
        candidateParentBoxId: modelProposal.candidateParentBoxId ?? null,
        keywords: modelProposal.keywords,
        evidence: modelProposal.evidence,
        sourceSummaryIds: modelProposal.sourceSummaryIds,
        sourceTurnRanges
      });

      proposals.push(buildProposal({
        id: proposalId,
        proposalType: "box",
        title: modelProposal.title,
        rationale: modelProposal.rationale,
        confidence: modelProposal.confidence,
        reviewedAt: request.reviewedAt,
        sourceSummaryIds: modelProposal.sourceSummaryIds,
        sourceTurnRanges,
        targetBoxIds: [boxId],
        targetTraceIds: [],
        payload
      }));
    }

    for (const modelProposal of output.parentChildProposals) {
      assertKnownSummaryIds(modelProposal.sourceSummaryIds, summariesById);
      if (!knownBoxIds.has(modelProposal.parentBoxId) && !proposedBoxIds.has(modelProposal.parentBoxId)) {
        throw new OpenRouterProposalPlannerError(`Model referenced unknown parent box ${modelProposal.parentBoxId}.`);
      }
      if (!knownBoxIds.has(modelProposal.childBoxId) && !proposedBoxIds.has(modelProposal.childBoxId)) {
        throw new OpenRouterProposalPlannerError(`Model referenced unknown child box ${modelProposal.childBoxId}.`);
      }

      const proposalId = `proposal_parent_child_${modelProposal.parentBoxId}_${modelProposal.childBoxId}`;
      if (hasExistingProposal(request.proposals, proposalId)) {
        continue;
      }

      const sourceSummaries = modelProposal.sourceSummaryIds.map((summaryId) => summariesById.get(summaryId)!);
      const sourceTurnRanges = dedupeTurnRanges(sourceSummaries.flatMap((summary) => summary.sourceTurnRanges));
      const payload = ParentChildProposalPayloadSchema.parse({
        parentBoxId: modelProposal.parentBoxId,
        childBoxId: modelProposal.childBoxId,
        relationshipLabel: modelProposal.relationshipLabel,
        rationale: modelProposal.rationale,
        sourceSummaryIds: modelProposal.sourceSummaryIds
      });

      proposals.push(buildProposal({
        id: proposalId,
        proposalType: "box_parent_child",
        title: `${modelProposal.childBoxId} parent assignment`,
        rationale: modelProposal.rationale,
        confidence: modelProposal.confidence,
        reviewedAt: request.reviewedAt,
        sourceSummaryIds: modelProposal.sourceSummaryIds,
        sourceTurnRanges,
        targetBoxIds: [modelProposal.parentBoxId, modelProposal.childBoxId],
        targetTraceIds: [],
        payload
      }));
    }

    return { proposals, skippedCandidates: [] };
  }

  async proposeTraces(request: TraceProposalPlanningRequest): Promise<TraceProposalPlanningResult> {
    const output = await this.requestPlannerOutput("trace", request);
    const summariesById = new Map(request.summaries.map((summary) => [summary.id, summary]));
    const knownBoxIds = new Set(request.boxes.map((box) => box.id));
    const proposals: MemoryProposal[] = [];

    for (const modelProposal of output.traceProposals) {
      assertKnownSummaryIds(modelProposal.summaryIds, summariesById);
      for (const boxId of modelProposal.boxIds) {
        if (!knownBoxIds.has(boxId)) {
          throw new OpenRouterProposalPlannerError(`Model referenced unknown trace box ${boxId}.`);
        }
      }

      const traceId = modelProposal.traceId ?? traceIdFromTitle(modelProposal.title);
      const proposalId = `proposal_trace_${traceId}`;
      if (hasExistingProposal(request.proposals, proposalId) ||
        request.traces.some((trace) => trace.id === traceId && trace.state !== "rejected")) {
        continue;
      }

      const sourceSummaries = modelProposal.summaryIds.map((summaryId) => summariesById.get(summaryId)!);
      const sourceTurnRanges = dedupeTurnRanges(sourceSummaries.flatMap((summary) => summary.sourceTurnRanges));
      const payload = TraceProposalPayloadSchema.parse({
        traceId,
        title: modelProposal.title,
        description: modelProposal.description,
        traceType: modelProposal.traceType,
        summaryIds: modelProposal.summaryIds,
        boxIds: modelProposal.boxIds,
        turnRanges: sourceTurnRanges,
        continuityReason: modelProposal.continuityReason,
        boundaryReason: modelProposal.boundaryReason,
        keywords: modelProposal.keywords
      });

      proposals.push(buildProposal({
        id: proposalId,
        proposalType: "trace",
        title: modelProposal.title,
        rationale: modelProposal.rationale,
        confidence: modelProposal.confidence,
        reviewedAt: request.reviewedAt,
        sourceSummaryIds: modelProposal.summaryIds,
        sourceTurnRanges,
        targetBoxIds: modelProposal.boxIds,
        targetTraceIds: [traceId],
        payload
      }));
    }

    return { proposals, skippedCandidates: [] };
  }

  private async requestPlannerOutput(
    mode: "box" | "trace",
    request: BoxProposalPlanningRequest | TraceProposalPlanningRequest
  ): Promise<PlannerOutput> {
    const payload = toPromptPayload(mode, request);
    let content: string;
    try {
      const result = await this.client.chatJson({
        model: this.providerModel,
        stage: mode === "box" ? "boxes" : "traces",
        promptVersion: PROMPT_VERSION,
        cacheInput: payload,
        messages: [
          { role: "system", content: PERSONAL_AGENT_PLANNER_PROMPT },
          { role: "user", content: JSON.stringify(payload) }
        ]
      });
      content = result.content;
    } catch (error) {
      if (error instanceof OpenRouterRequestError) {
        throw new OpenRouterProposalPlannerError(error.message, error.status, error.responseText);
      }
      throw error;
    }
    const plannerOutput = parseJson(content, "OpenRouter model returned invalid planner JSON.");
    const parsedPlannerOutput = PlannerOutputSchema.safeParse(plannerOutput);
    if (!parsedPlannerOutput.success) {
      throw new OpenRouterProposalPlannerError(
        `OpenRouter planner JSON did not match the expected shape: ${parsedPlannerOutput.error.message}`,
        undefined,
        content
      );
    }
    return parsedPlannerOutput.data;
  }
}

export function createProposalPlannersFromEnv(
  env: OpenRouterProposalPlannerEnvironment = process.env,
  overrides: Partial<Omit<OpenRouterProposalPlannerOptions, "apiKey" | "model">> = {}
): { boxPlanner: BoxProposalPlanner; tracePlanner: TraceProposalPlanner } | null {
  if (!env.OPENROUTER_API_KEY?.trim() || !env.OPENROUTER_MODEL?.trim()) {
    return null;
  }

  const planner = OpenRouterProposalPlanner.fromEnv(env, overrides);
  return {
    boxPlanner: planner,
    tracePlanner: planner
  };
}

function buildProposal(input: {
  id: string;
  proposalType: ProposalType;
  title: string;
  rationale: string;
  confidence: number;
  reviewedAt: string;
  sourceSummaryIds: string[];
  sourceTurnRanges: MemoryProposal["sourceTurnRanges"];
  targetBoxIds: string[];
  targetTraceIds: string[];
  payload: MemoryProposal["payload"];
}): MemoryProposal {
  return {
    id: input.id,
    proposalType: input.proposalType,
    state: "proposed",
    title: input.title,
    rationale: input.rationale,
    confidence: input.confidence,
    createdAt: input.reviewedAt,
    reviewedAt: input.reviewedAt,
    decidedAt: null,
    decidedBy: null,
    decisionNote: null,
    sourceSummaryIds: input.sourceSummaryIds,
    sourceTurnRanges: input.sourceTurnRanges,
    targetBoxIds: input.targetBoxIds,
    targetTraceIds: input.targetTraceIds,
    payload: input.payload
  };
}

function assertKnownSummaryIds(summaryIds: string[], summariesById: Map<string, Summary>): void {
  for (const summaryId of summaryIds) {
    if (!summariesById.has(summaryId)) {
      throw new OpenRouterProposalPlannerError(`Model referenced unknown summary ${summaryId}.`);
    }
  }
}

function toPromptPayload(
  mode: "box" | "trace",
  request: BoxProposalPlanningRequest | TraceProposalPlanningRequest
): unknown {
  return {
    mode,
    promptVersion: PROMPT_VERSION,
    reviewedAt: request.reviewedAt,
    summaries: request.summaries.map(summaryPrompt),
    boxes: request.boxes.map(boxPrompt),
    anchors: request.anchors.map(anchorPrompt),
    pendingProposals: request.proposals.map(proposalPrompt),
    traces: "traces" in request ? request.traces.map(tracePrompt) : []
  };
}

function summaryPrompt(summary: Summary): unknown {
  return {
    id: summary.id,
    summaryText: summary.summaryText,
    sourceTurnRanges: summary.sourceTurnRanges,
    boxIds: summary.boxIds,
    state: summary.state,
    createdAt: summary.createdAt
  };
}

function boxPrompt(box: Box): unknown {
  return {
    id: box.id,
    title: box.title,
    summary: box.summary,
    parentBoxId: box.parentBoxId,
    childBoxIds: box.childBoxIds,
    boxType: box.boxType,
    state: box.state,
    summaryIds: box.summaryIds
  };
}

function anchorPrompt(anchor: Anchor): unknown {
  return {
    id: anchor.id,
    boxId: anchor.boxId,
    anchorType: anchor.anchorType,
    content: anchor.content,
    source: anchor.source
  };
}

function proposalPrompt(proposal: MemoryProposal): unknown {
  return {
    id: proposal.id,
    proposalType: proposal.proposalType,
    title: proposal.title,
    targetBoxIds: proposal.targetBoxIds,
    targetTraceIds: proposal.targetTraceIds
  };
}

function tracePrompt(trace: MemoryTrace): unknown {
  return {
    id: trace.id,
    title: trace.title,
    summaryIds: trace.summaryIds,
    boxIds: trace.boxIds,
    state: trace.state
  };
}

function boxIdFromTitle(title: string): string {
  return `box_topic_${slugify(title)}`;
}

function traceIdFromTitle(title: string): string {
  return `trace_${slugify(title)}`;
}

function parseJson(value: string, message: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new OpenRouterProposalPlannerError(message, undefined, value);
  }
}
