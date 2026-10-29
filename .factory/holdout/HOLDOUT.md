# Independent holdout: Conversational Memory System

Use a separate fresh scope and protected synthetic inputs distinct from the runtime fixture.

Required assertions: Independent synthetic person/scope cannot retrieve another scope; duplicate synthetic summary write is idempotent; person/scope identity and exact summary text survive reopen.

Never accept product unit tests alone as this holdout. Retain exact inputs, observed output, candidate digest and owned teardown receipt.

Excluded: Live memory corpus, actual Claude/Codex/Hermes history, daemon/LaunchAgents, relay/keychain, external models and ONNX golden coverage without its pinned fixtures.
