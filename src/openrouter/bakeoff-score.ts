import { z } from "zod";

export const EMBEDDING_MODEL = "google/gemini-embedding-2";

export const CHAT_BAKEOFF_MODELS = [
  "openai/gpt-6-luna-pro",
  "anthropic/claude-haiku-5.5",
  "~deepseek/deepseek-flash-latest",
  "z-ai/glm-5.3-flash"
] as const;

const SummaryContentSchema = z.object({
  title: z.string().min(1).optional(),
  summaryText: z.string().min(1),
  confidence: z.number().min(0).max(1),
  detailLevel: z.enum(["full", "medium", "brief", "stub"]),
  tokenCount: z.number().int().nonnegative(),
  anchors: z.array(z.object({
    anchorType: z.enum(["deadline", "decision", "key_fact", "strategic_insight", "bookmark"]),
    content: z.string().min(1),
    turnSequence: z.number().int().nonnegative().optional()
  })).optional()
});

export interface BakeoffCase {
  id: string;
  requiredTerms: string[];
  forbiddenTerms: string[];
  payload: unknown;
}

export interface BakeoffScore {
  parsed: boolean;
  schemaValid: boolean;
  requiredHits: string[];
  requiredMisses: string[];
  forbiddenHits: string[];
  title: string | null;
  summaryText: string | null;
}

export function parseModelJson(content: string): unknown {
  const trimmed = content.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const candidate = fenced?.[1] ?? trimmed;
  return JSON.parse(candidate);
}

export function scoreSummary(content: string, testCase: BakeoffCase): BakeoffScore {
  let parsed: unknown;
  try {
    parsed = parseModelJson(content);
  } catch {
    return {
      parsed: false,
      schemaValid: false,
      requiredHits: [],
      requiredMisses: testCase.requiredTerms,
      forbiddenHits: [],
      title: null,
      summaryText: null
    };
  }
  const result = SummaryContentSchema.safeParse(parsed);
  const summaryText = result.success
    ? result.data.summaryText
    : textField(parsed, "summaryText") ?? textField(parsed, "summary");
  const title = result.success ? result.data.title ?? null : textField(parsed, "title");
  const haystack = [title, summaryText, result.success ? JSON.stringify(result.data.anchors ?? []) : ""].join("\n");
  const requiredHits = testCase.requiredTerms.filter((term) => haystack.includes(term));
  return {
    parsed: true,
    schemaValid: result.success,
    requiredHits,
    requiredMisses: testCase.requiredTerms.filter((term) => !requiredHits.includes(term)),
    forbiddenHits: testCase.forbiddenTerms.filter((term) => haystack.includes(term)),
    title,
    summaryText
  };
}

export function qualityPoints(score: BakeoffScore, testCase: BakeoffCase): number {
  const required = testCase.requiredTerms.length === 0
    ? 1
    : score.requiredHits.length / testCase.requiredTerms.length;
  const schema = score.schemaValid ? 1 : 0;
  const clean = score.forbiddenHits.length === 0 ? 1 : 0;
  return Number(((schema * 0.4) + (required * 0.4) + (clean * 0.2)).toFixed(3));
}

function textField(value: unknown, key: string): string | null {
  if (!value || typeof value !== "object") return null;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" && field.trim() ? field : null;
}

export const CHAT_BAKEOFF_CASES: BakeoffCase[] = [
  {
    id: "coverage-decision",
    requiredTerms: ["PIP", "BI", "Martinez v. Hale", "2026-11-03"],
    forbiddenTerms: ["settled", "criminal"],
    payload: {
      topic: { label: "open topic", summary: "open topic", turnCount: 2, completedAt: "2026-10-16T15:00:00.000Z" },
      sourceTurns: [
        { sequence: 1, role: "user", content: "On Martinez v. Hale we should tender the BI claim and leave PIP alone. The hearing is 2026-11-03." },
        { sequence: 2, role: "assistant", content: "Noted. BI is the claim to tender. PIP stays untouched. Hearing date 2026-11-03." }
      ]
    }
  },
  {
    id: "personal-preference",
    requiredTerms: ["morning", "conversational-memory-system"],
    forbiddenTerms: ["password"],
    payload: {
      topic: { label: "open topic", summary: "open topic", turnCount: 2, completedAt: "2026-10-16T15:10:00.000Z" },
      sourceTurns: [
        { sequence: 1, role: "user", content: "I prefer morning writing time for the conversational-memory-system repo. Do not store client documents." },
        { sequence: 2, role: "assistant", content: "I will remember the morning writing preference for conversational-memory-system and keep client documents out of memory." }
      ]
    }
  },
  {
    id: "uncertain-budget",
    requiredTerms: ["4000", "travel"],
    forbiddenTerms: ["invoice"],
    payload: {
      topic: { label: "open topic", summary: "open topic", turnCount: 1, completedAt: "2026-10-16T15:20:00.000Z" },
      sourceTurns: [
        { sequence: 1, role: "user", content: "I think the travel budget was about 4000 but I am not sure. Nothing has been approved." }
      ]
    }
  }
];
