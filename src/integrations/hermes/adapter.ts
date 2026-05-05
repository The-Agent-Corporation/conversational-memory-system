import { AnchorDetector } from "../../anchors/anchor-detector.js";
import { PreCompactor, type PreCompactionResult } from "../../compaction/pre-compactor.js";
import type { Anchor, InjectionPacket, Turn } from "../../domain/types.js";
import { MemoryService } from "../../service/memory-service.js";
import type { MemoryStore } from "../../storage/memory-store.js";
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

export class HermesMemoryAdapter {
  private readonly service: MemoryService;
  private readonly monitor = new TopicMonitor();
  private readonly anchorDetector: AnchorDetector;
  private readonly preCompactor: PreCompactor;

  constructor(store: MemoryStore) {
    this.service = new MemoryService(store);
    this.anchorDetector = new AnchorDetector(store);
    this.preCompactor = new PreCompactor(store);
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

  async prepareCurrentTopicInjection(hostSessionId: string, requestedAt?: string): Promise<InjectionPacket | null> {
    const currentTopic = this.monitor.current(hostSessionId);

    if (!currentTopic) {
      return null;
    }

    return this.service.prepareInjection({
      host: currentTopic.host,
      profileId: currentTopic.profileId,
      hostSessionId,
      currentTopicSummary: currentTopic.currentTopicSummary,
      requestedAt
    });
  }
}
