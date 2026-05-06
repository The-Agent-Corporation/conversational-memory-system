import { AnchorDetector } from "../../anchors/anchor-detector.js";
import { PreCompactor, type PreCompactionResult } from "../../compaction/pre-compactor.js";
import type { Anchor, InjectionPacket, Turn } from "../../domain/types.js";
import type { Embedder } from "../../embeddings/embedder.js";
import { ConversationResumer, type ResumeResult } from "../../resume/conversation-resumer.js";
import { MemoryService } from "../../service/memory-service.js";
import type { MemoryStore } from "../../storage/memory-store.js";
import {
  createSummarizerFromEnv,
  type Summarizer,
  type SummarizerEnvironment,
  type SummarizerFactoryOptions
} from "../../summarization/summarizer.js";
import {
  TopicMonitor,
  type CompletedTopicSpan,
  type RollingTopicState
} from "../../topic/topic-monitor.js";
import {
  mapHermesTimelineRowToHostEvent,
  type HermesTimelineRow
} from "./contract.js";

export interface HermesAdapterResult {
  turn: Turn | null;
  anchors: Anchor[];
  currentTopic: RollingTopicState | null;
  completedTopic: CompletedTopicSpan | null;
  compaction: PreCompactionResult | null;
}

export interface HermesMemoryAdapterOptions {
  summarizer?: Summarizer;
  embedder?: Embedder;
  env?: SummarizerEnvironment;
  summarizerOptions?: SummarizerFactoryOptions;
}

export interface HermesInjectionOptions {
  requestedAt?: string;
  maxMemoryTokens?: number;
}

export class HermesMemoryAdapter {
  private readonly service: MemoryService;
  private readonly monitor = new TopicMonitor();
  private readonly anchorDetector: AnchorDetector;
  private readonly preCompactor: PreCompactor;
  private readonly resumer: ConversationResumer;

  constructor(store: MemoryStore, options: HermesMemoryAdapterOptions = {}) {
    this.service = new MemoryService(store, { embedder: options.embedder });
    this.anchorDetector = new AnchorDetector(store);
    this.preCompactor = new PreCompactor(
      store,
      options.summarizer ?? createSummarizerFromEnv(options.env, options.summarizerOptions),
      options.embedder
    );
    this.resumer = new ConversationResumer(store);
  }

  async processTimelineRow(row: HermesTimelineRow): Promise<HermesAdapterResult> {
    const event = mapHermesTimelineRowToHostEvent(row);
    const turn = await this.service.ingestEvent(event);
    const topicResult = this.monitor.observe(event);
    const anchorResult = turn ? await this.anchorDetector.detectForTurn(turn) : { anchors: [] };
    const compaction = topicResult.completed
      ? await this.preCompactor.compactCompletedTopic(topicResult.completed)
      : null;

    return {
      turn,
      anchors: anchorResult.anchors,
      currentTopic: topicResult.current,
      completedTopic: topicResult.completed,
      compaction
    };
  }

  async prepareCurrentTopicInjection(
    hostSessionId: string,
    options: string | HermesInjectionOptions = {}
  ): Promise<InjectionPacket | null> {
    const currentTopic = this.monitor.current(hostSessionId);
    const injectionOptions = typeof options === "string"
      ? { requestedAt: options }
      : options;

    if (!currentTopic) {
      return null;
    }

    return this.service.prepareInjection({
      host: currentTopic.host,
      profileId: currentTopic.profileId,
      hostSessionId,
      currentTopicSummary: currentTopic.currentTopicSummary,
      requestedAt: injectionOptions.requestedAt,
      maxMemoryTokens: injectionOptions.maxMemoryTokens
    });
  }

  async resumeSummary(summaryId: string): Promise<ResumeResult> {
    return this.resumer.resumeSummary(summaryId);
  }

  async resumeInjection(packet: InjectionPacket): Promise<ResumeResult> {
    return this.resumer.resumeInjection(packet);
  }
}
