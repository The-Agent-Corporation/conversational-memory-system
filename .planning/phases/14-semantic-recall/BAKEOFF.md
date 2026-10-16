# Model bakeoff

`npx tsx scripts/model-bakeoff.ts` calls OpenRouter when `OPENROUTER_API_KEY` is set and writes a skip receipt when it is not. `BAKEOFF_REPEATS=N` reruns every case N times. Results go to `.planning/phases/14-semantic-recall/bakeoff-results.json`.

Each case checks JSON shape against the summarizer schema, exact term preservation, and invented terms. The harness scores three fixed synthetic spans, not the private corpus. `~/.memory/aaron.db` is not on the cloud machine. Provider data collection is denied, and the run stops at $5 of recorded spend.

The embedding model for this pass is fixed: `google/gemini-embedding-2`. The probe call returned 768 dimensions in about 0.5 s for $0.0000013.

## Live run, 2026-10-16

The OpenRouter key ("Roscoe") was delivered from LimitSwitch Cloud into a private file outside the repository. Prompt `openrouter-summarizer-v3`, three repeats, 36 chat calls, $0.017 total.

| Model | Passed | Mean quality | Median latency | Cost for 9 calls |
| --- | --- | --- | --- | --- |
| `anthropic/claude-haiku-5.5` | 9/9 | 1.00 | 2.1 s | $0.0022 |
| `z-ai/glm-5.3-flash` | 9/9 | 1.00 | 8.8 s | $0.0032 |
| `~deepseek/deepseek-flash-latest` | 9/9 | 1.00 | 5.0 s | $0.0055 |
| `openai/gpt-6-luna-pro` | 9/9 | 1.00 | 7.9 s | $0.0064 |

`openai/gpt-6-luna-pro` bills about 2,600 prompt tokens for inputs the other models count as 250 to 450, which is why it costs the most at the same listed price. `z-ai/glm-5.3-flash` latency varied from 0.8 s to 4.2 s on the first run and was slower on this one.

### Confidence on uncertain input

The scorer does not grade `confidence`. A separate three-sample check compared a settled decision ("tender BI, leave PIP alone") with an unsure recollection ("about 4000 but I am not sure"):

| Model | Settled decision | Unsure budget |
| --- | --- | --- |
| `anthropic/claude-haiku-5.5` | 0.9, 0.9, 0.9 | 0.4, 0.4, 0.3 |
| `~deepseek/deepseek-flash-latest` | 0.95, 0.95, 0.95 | 0.3, 0.35, 0.3 |
| `z-ai/glm-5.3-flash` | 0.95, 0.9, 0.95 | 0.5, 0.4, 0.5 |
| `openai/gpt-6-luna-pro` | 1, 1, 1 | 0.95, 0.75, 0.85 |

### Prompt v2 failures

The first live run used `openrouter-summarizer-v2`. Five of 12 outputs failed the schema because the prompt named `detailLevel` without its allowed values, and models returned `"low"` or `"concise"`. `OpenRouterSummarizer` rejects those summaries. Two outputs wrote the budget as "4,000" or "$4,000". v3 lists the allowed values and the `confidence` range and asks for numbers as written. After that change every model passed every case.

## Reading the result

The three cases no longer separate the models on quality. On this evidence `anthropic/claude-haiku-5.5` is the fastest, the cheapest, and lowers confidence when the speaker is unsure. `openai/gpt-6-luna-pro` is the weakest fit: it is the slowest of the reliable models, the most expensive, and overconfident on uncertain input.

A model choice should still be checked on real spans. The next step is a cloned-corpus rebuild and the Phase 14 recall probe against `aaron.db`, which is a separate paid step.
