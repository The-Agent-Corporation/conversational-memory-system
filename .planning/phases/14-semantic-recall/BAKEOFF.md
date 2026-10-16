# Model bakeoff

The live chat comparison has not run on this machine: `OPENROUTER_API_KEY` is unset, and there is no `~/.memory/aaron.db` clone. The harness scores three fixed spans instead of the private corpus.

`npx tsx scripts/model-bakeoff.ts` calls OpenRouter when `OPENROUTER_API_KEY` is set and writes a skip receipt when it is not.

The embedding model for this pass is fixed: `google/gemini-embedding-2` (768 dimensions on the probe call).

Chat candidates, scored on the personal-agent summary prompt:

- `openai/gpt-6-luna-pro`
- `anthropic/claude-haiku-5.5`
- `~deepseek/deepseek-flash-latest`
- `z-ai/glm-5.3-flash`

`npx tsx scripts/model-bakeoff.ts` writes `.planning/phases/14-semantic-recall/bakeoff-results.json`. Each case checks JSON shape, exact term preservation, and invented terms. Provider data collection is denied. The daily cap for the run is $5.

A full rebuild of a cloned corpus stays a separate paid step after a model is chosen.
