# Example Memory Systems Notes

Reviewed sources:

- `example/letta-main`
- `example/graphiti-main`
- `example/Membox-main`
- arXiv abstracts for MemBox and Zep/Graphiti:
  - https://arxiv.org/abs/2601.03785
  - https://arxiv.org/abs/2501.13956

## Letta

Relevant files:

- `example/letta-main/letta/prompts/system_prompts/sleeptime_v2.py`
- `example/letta-main/letta/prompts/system_prompts/voice_sleeptime.py`
- `example/letta-main/letta/prompts/system_prompts/summary_system_prompt.py`
- `example/letta-main/letta/groups/sleeptime_multi_agent_v4.py`
- `example/letta-main/tests/integration_test_sleeptime_agent.py`

Useful patterns:

- Sleeptime is a background role, not the primary conversation agent.
- The background agent runs after foreground turns, optionally on a frequency counter.
- It receives a bounded transcript since the last processed message rather than the full world.
- It should skip edits when no meaningful memory update exists.
- It can make precise edits or rewrite a whole memory block, but it must finish explicitly.
- Prompts emphasize high recall plus selectivity.
- Persistent memory must avoid relative time language such as "today" and "recently".
- Voice sleeptime splits work into two phases: archive older dialogue chunks, then refine a durable user memory block.

Implications for this project:

- Our next background agent should be explicitly separate from Roscoe's foreground answer path.
- It should run on demand first, then later on a schedule or turn frequency.
- It should operate over compacted summaries and source ranges, not raw context by default.
- It should return structured proposals/actions and always finish with a clear completion result.
- It should not automatically rewrite all durable structure unless a bounded proposal/action passes validation.

## MemBox

Relevant files:

- `example/Membox-main/README.md`
- `example/Membox-main/membox.py`

Useful patterns:

- MemBox's core premise matches our design: preserve topic continuity at storage time instead of fragmenting into isolated utterances and trying to recover coherence later.
- The paper abstract describes a two-tier design: Topic Loom groups adjacent same-topic turns into memory boxes; Trace Weaver links sealed boxes into long-range event timeline traces.
- The code uses a message-continuation prompt that answers whether the current message continues the prior topic.
- Each box is enriched with topic, keywords, and explicit mentions/events.
- Trace building uses embedding shortlist first, then LLM filtering to decide whether new events continue an existing event chain.
- The event-chain prompt distinguishes "same core activity" from merely similar topic.
- Retrieval can rank boxes using combined content, events, topic, and keywords.
- The QA prompt stresses timestamp-aware reasoning and conversion of relative dates into absolute dates.

Implications for this project:

- Our boxes should not be only labels; they should carry topic, keywords, explicit events, source ranges, and rationale.
- The next reviewer should propose boxes from continuity plus event/fact structure, not just the first two summary tokens.
- We need a trace layer or equivalent link type for recurring case/project subthreads across non-contiguous conversations.
- Event chains should be conservative: "same case" is not enough; the chain should advance the same activity, issue, plan, or factual development.
- Time normalization matters for legal work; persisted memory and answer support should prefer absolute dates.

## Graphiti

Relevant files:

- `example/graphiti-main/README.md`
- `example/graphiti-main/graphiti_core/prompts/extract_nodes.py`
- `example/graphiti-main/graphiti_core/prompts/extract_edges.py`
- `example/graphiti-main/graphiti_core/prompts/dedupe_nodes.py`
- `example/graphiti-main/graphiti_core/prompts/dedupe_edges.py`
- `example/graphiti-main/graphiti_core/prompts/summarize_nodes.py`
- `example/graphiti-main/graphiti_core/prompts/summarize_sagas.py`
- `example/graphiti-main/graphiti_core/prompts/snippets.py`

Useful patterns:

- Graphiti's memory unit is temporal context graph: entities, facts/relationships, and episodes.
- Episodes preserve raw provenance; derived facts trace back to source data.
- Facts have validity windows and can be invalidated/superseded without deleting history.
- Prompts are strict about extracting only explicit, concrete entities/facts.
- Dedupe is conservative: similar or related things are not automatically duplicates.
- Contradiction handling is separate from duplication.
- Summaries should state facts directly and avoid meta-language like "mentioned" or "discussed".
- Temporal extraction resolves relative dates against an episode/reference time.
- The README emphasizes hybrid retrieval: semantic, keyword, and graph traversal.

Implications for this project:

- Keep our source turns and summaries as provenance roots; do not collapse history destructively.
- Add valid/superseded/disputed thinking before overwriting durable facts.
- Treat case/client/project entities as optional graph-like metadata that can enrich boxes without forcing a graph database now.
- Structured outputs and validation should be mandatory for background organization.
- Retrieval should eventually use boxes, anchors, explicit events, and temporal facts together.

## Recommended Next Phase

Name: Sleep Review and Trace Planning.

Goal: turn the existing basic `SleepReviewer` into a background organization pipeline that can propose useful memory structure without directly mutating approved structure.

Phase 1: `hermes:sleep`

- Add a standalone command that opens the SQLite store and runs sleep review.
- It should return JSON with:
  - decayed summaries
  - refreshed boxes
  - proposed boxes
  - no-op reason when nothing meaningful changed
- Keep it deterministic at first so the command is reliable and testable.

Phase 2: richer box proposals

- Replace first-two-token grouping with a `BoxProposalPlanner`.
- Inputs: summaries, anchors, existing boxes.
- Outputs: proposed boxes with title, description, rationale, source summary ids, source turn ranges, confidence, and candidate parent box id.
- Start deterministic with token/event overlap; add OpenRouter-backed structured proposal later.

Phase 3: trace/link proposals

- Add a lightweight `Trace` or `MemoryLink` contract before any full graph layer.
- Link summaries/boxes when events continue the same activity, issue, plan, or factual development across non-contiguous spans.
- Store proposed links separately from approved links.

Phase 4: Roscoe surface

- Add a Roscoe tool or command for explicit sleep review on request.
- Do not create a dashboard yet.
- The foreground agent can ask for sleep review results when planning or when the user asks what changed.

Design guardrails:

- Preserve provenance to source turns for every proposal.
- Prefer proposed state over automatic approval.
- Avoid rewriting approved boxes unless explicitly approved.
- Avoid relative dates in durable summaries/proposals.
- Separate duplicate detection from contradiction/supersession.
- Keep background review best-effort and non-blocking for foreground chat.
