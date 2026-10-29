# Conversational Memory System factory contract

Actual private SQLite store and deterministic source modules; synthetic people/scopes only; no imported agent histories.

Ordinary checks: `python3 harness/ci.py`. GitHub check name: **Factory deterministic checks** (new workflow; requires actual GitHub run readback before readiness binding).

Runtime binding helper: `/Users/aaronwhaley/Agent-Corporation/factory/project-runtimes/conversational-memory-system/bindings.py`. Interface: `create --project-root <delivered-checkout> --output <new-private-directory>`. Use returned immutable runtime/holdout scenarios with the native verifier; do not reuse scopes after failure/retry. Candidate source SHA and measured process identity must agree. Teardown requires the same invocation and nonce plus exited child evidence.

Activation remains observation-only until native healthy/defect/wrong-identity/holdout calibration, exact GitHub check mapping and a supervised coding pilot pass. No merge or deploy is implied.

Limits: Live memory corpus, actual Claude/Codex/Hermes history, daemon/LaunchAgents, relay/keychain, external models and ONNX golden coverage without its pinned fixtures.
