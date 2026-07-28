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
  type RollingTopicState,
  type TopicMonitorResult
} from "../../topic/topic-monitor.js";
import { drivesTopicLabel } from "../../topic/derivation-hygiene.js";
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

export interface HermesMemorySearchRequest {
  profileId: string;
  hostSessionId: string;
  query: string;
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
    this.service = new MemoryService(store, {
      embedder: options.embedder,
      allowLegacyUnscopedRetrieval: true
    });
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

    // 11-CONTEXT decision 5: the live bridge applies the SAME shared hygiene classifier as
    // the daemon/contraction path. control_signal events always reach the monitor (they close
    // spans); conversation_turn events only drive topic labeling when drivesTopicLabel says so.
    // Note: this live path never sets eventKind today, so `role: "tool"` is the tool signal here.
    const topicResult: TopicMonitorResult =
      event.type === "control_signal" ||
      drivesTopicLabel({ content: event.content, eventKind: event.eventKind, role: event.role })
        ? this.monitor.observe(event)
        : { current: this.monitor.current(event.hostSessionId), topicChanged: false, completed: null };

    // GAP-11-G: forward the same third classification input the topic gate above already receives, so
    // the anchor gate and the topic gate can never disagree on this seam. `event.eventKind` is
    // undefined for every Hermes row today, which is exactly the pre-11-27 gate inputs — this is a
    // tightening that arms itself if Hermes ever starts emitting a kind, not a behavior change now.
    const eventKind = event.type === "conversation_turn" ? event.eventKind : undefined;
    const anchorResult = turn
      ? await this.anchorDetector.detectForTurn(turn, { eventKind })
      : { anchors: [] };
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

  async searchMemory(request: HermesMemorySearchRequest): Promise<InjectionPacket | null> {
    const packet = await this.service.prepareInjection({
      host: "roscoe-hermes",
      profileId: request.profileId,
      hostSessionId: request.hostSessionId,
      currentTopicSummary: request.query,
      requestedAt: request.requestedAt,
      maxMemoryTokens: request.maxMemoryTokens
    });

    if (!packet) {
      return null;
    }

    return {
      ...packet,
      disclosureText: `Searched memory for "${request.query}". ${packet.disclosureText}`
    };
  }

  async resumeSummary(summaryId: string): Promise<ResumeResult> {
    return this.resumer.resumeSummary(summaryId);
  }

  async resumeInjection(packet: InjectionPacket): Promise<ResumeResult> {
    return this.resumer.resumeInjection(packet);
  }
}
