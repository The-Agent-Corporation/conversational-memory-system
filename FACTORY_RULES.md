# Factory rules

AGENTS.md, CLAUDE.md and current docs/adr/ decisions define product authority.
GSD was retired on 2026-08-09; .planning/STATE.md is frozen historical evidence,
and old roadmap phases or unchecked queue entries do not establish current work.
Before starting a coding run, bind a currently authorized issue or assignment to
the actual source and current decisions, with explicit scope, acceptance criteria,
dependencies and ownership. If no current assignment is established, keep intake
held and request Aaron's selection. A factory issue records that assignment; it
does not revive the retired worklist or create product scope.

Aaron owns scope and exact-head merge decisions. Archon runs the shared factory. Port records controls and evidence. One active run per project; respect existing claims. This setup does not authorize automatic source merges or deployment.

Use a clean worktree and fresh private fixture state. Do not read operator credentials, .env, browser profiles, documents, databases or agent histories. Runtime and holdout are separate fresh scopes. Preserve all other worktrees and user edits. Never message another user-owned coding chat.

Protected policy/evidence paths: MISSION.md, FACTORY.md, FACTORY_RULES.md, AGENTS.md, CLAUDE.md, engineering.md, harness/, .factory/, factory/, .github/workflows/.

Verification limits: Live memory corpus, actual Claude/Codex/Hermes history, daemon/LaunchAgents, relay/keychain, external models and ONNX golden coverage without its pinned fixtures. An unavailable environment is inconclusive, never a passing assertion. A skipped test is not coverage.
