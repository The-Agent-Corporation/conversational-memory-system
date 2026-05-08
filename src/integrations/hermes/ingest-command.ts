import { pathToFileURL } from "node:url";
import { z } from "zod";
import { PreCompactor, type PreCompactionResult } from "../../compaction/pre-compactor.js";
import type { ConversationTurnEvent, ControlSignalEvent } from "../../domain/events.js";
import type { Turn } from "../../domain/types.js";
import { SqliteStore } from "../../storage/sqlite-store.js";
import { TopicMonitor, type RollingTopicState, type CompletedTopicSpan } from "../../topic/topic-monitor.js";
import { HermesMemoryAdapter } from "./adapter.js";
import {
  HermesTimelineRowSchema,
  mapHermesTimelineRowToHostEvent,
  type HermesTimelineRow
} from "./contract.js";

const IngestOptionsSchema = z.object({
  databasePath: z.string().min(1),
  input: z.string().min(1)
});

export interface HermesIngestResult {
  ok: true;
  turnId: string | null;
  completedTopic: string | null;
  summaryId: string | null;
}

export async function ingestHermesTimelineRow(options: {
  databasePath: string;
  input: string;
}): Promise<HermesIngestResult> {
  const parsedOptions = IngestOptionsSchema.parse(options);
  const row = HermesTimelineRowSchema.parse(JSON.parse(parsedOptions.input));
  const store = new SqliteStore(parsedOptions.databasePath);

  try {
    const controlCompaction = await compactStoredTopicForControlSignal(store, row);
    if (controlCompaction) {
      return {
        ok: true,
        turnId: null,
        completedTopic: controlCompaction.completedTopic,
        summaryId: controlCompaction.compaction.summary.id
      };
    }

    const adapter = new HermesMemoryAdapter(store);
    const result = await adapter.processTimelineRow(row);
    return {
      ok: true,
      turnId: result.turn?.id ?? null,
      completedTopic: result.completedTopic?.topicLabel ?? null,
      summaryId: result.compaction?.summary.id ?? null
    };
  } finally {
    store.close();
  }
}

async function compactStoredTopicForControlSignal(
  store: SqliteStore,
  row: HermesTimelineRow
): Promise<{ completedTopic: string; compaction: PreCompactionResult } | null> {
  const event = mapHermesTimelineRowToHostEvent(row);
  if (event.type !== "control_signal") {
    return null;
  }

  const turns = await unsummarizedTurnsBeforeControlSignal(store, row);
  if (turns.length === 0) {
    return null;
  }

  const monitor = new TopicMonitor();
  let firstTopic: RollingTopicState | null = null;
  for (const turn of turns) {
    const result = monitor.observe(turnToConversationEvent(turn, row));
    firstTopic ??= result.current;
  }

  const topicResult = monitor.observe(event);
  if (!topicResult.completed) {
    return null;
  }

  const completedSpan = completedSpanForUnsummarizedTail({
    event,
    turns,
    firstTopic,
    completed: topicResult.completed
  });
  const compactor = new PreCompactor(store);
  return {
    completedTopic: completedSpan.topicLabel,
    compaction: await compactor.compactCompletedTopic(completedSpan)
  };
}

async function unsummarizedTurnsBeforeControlSignal(
  store: SqliteStore,
  row: HermesTimelineRow
): Promise<Turn[]> {
  const [turns, summaries] = await Promise.all([
    store.listTurns(row.session_id),
    store.listSummaries()
  ]);
  let lastCompactedSequence = -1;
  for (const summary of summaries) {
    for (const range of summary.sourceTurnRanges) {
      if (range.threadId === row.session_id) {
        lastCompactedSequence = Math.max(lastCompactedSequence, range.endSequence);
      }
    }
  }

  return turns.filter(
    (turn) => turn.sequence > lastCompactedSequence && turn.sequence < row.sequence
  );
}

function completedSpanForUnsummarizedTail(options: {
  event: ControlSignalEvent;
  turns: Turn[];
  firstTopic: RollingTopicState | null;
  completed: CompletedTopicSpan;
}): CompletedTopicSpan {
  const startSequence = options.turns[0]?.sequence ?? options.completed.sourceTurnRange.startSequence;
  const endSequence = options.turns.at(-1)?.sequence ?? options.completed.sourceTurnRange.endSequence;
  const topicLabel = options.firstTopic?.topicLabel ?? options.completed.topicLabel;

  return {
    ...options.completed,
    topicLabel,
    currentTopicSummary: `${topicLabel} (${options.turns.length} turn${options.turns.length === 1 ? "" : "s"}, seq ${startSequence}-${endSequence})`,
    sourceTurnRange: {
      threadId: options.completed.hostSessionId,
      startSequence,
      endSequence
    },
    turnCount: options.turns.length,
    completedAt: options.event.createdAt
  };
}

function turnToConversationEvent(turn: Turn, row: HermesTimelineRow): ConversationTurnEvent {
  return {
    id: turn.id,
    host: "roscoe-hermes",
    profileId: row.profile_id,
    hostSessionId: row.session_id,
    sequence: turn.sequence,
    type: "conversation_turn",
    role: turn.role,
    content: turn.content,
    createdAt: turn.createdAt,
    metadata: turn.metadata
  };
}

async function main(): Promise<void> {
  const databasePath = parseDatabasePath(process.argv.slice(2));
  const input = await readStdin();
  const result = await ingestHermesTimelineRow({ databasePath, input });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

function parseDatabasePath(args: string[]): string {
  const dbIndex = args.indexOf("--db");
  if (dbIndex >= 0 && args[dbIndex + 1]) {
    return args[dbIndex + 1];
  }

  const equalsArg = args.find((arg) => arg.startsWith("--db="));
  if (equalsArg) {
    return equalsArg.slice("--db=".length);
  }

  const envPath = process.env.HERMES_CONVERSATIONAL_MEMORY_DB;
  if (envPath) {
    return envPath;
  }

  throw new Error("Missing memory database path. Pass --db <path> or set HERMES_CONVERSATIONAL_MEMORY_DB.");
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];

  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks).toString("utf8");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
