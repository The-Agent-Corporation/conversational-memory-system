# Model bakeoff

This workspace has no Aaron corpus and no OpenRouter key, so the paid slice was not run.

`scripts/model-bakeoff.ts` compares the candidate chat and embedding models on a local JSON slice. It records quality notes, latency, and cost when `OPENROUTER_API_KEY` is set, and prints a skip receipt when it is not.

Candidates:

- Embeddings: `qwen/qwen3-embedding-8b`, `qwen/qwen3-embedding-4b`, `openai/text-embedding-3-small`
- Chat: `google/gemini-2.5-flash`, `anthropic/claude-3.5-haiku`, `openai/gpt-4o-mini`

A full rebuild of a cloned corpus stays a separate paid step after a model is chosen.
