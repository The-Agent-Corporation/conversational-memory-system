# Conversational Memory System factory contract

Actual private SQLite store and deterministic source modules; synthetic people/scopes only; no imported agent histories.

Ordinary checks: `python3 harness/ci.py`. GitHub check name: **Factory deterministic checks** (new workflow; requires actual GitHub run readback before readiness binding).

CI runs all portable tests on Ubuntu, including the unchanged performance floor,
and runs `tests/daemon/macos-adapters.test.ts` on macOS. The always-run required
aggregate fails unless both partitions succeed; skipped/cancelled jobs fail it.
The local ordinary command still runs the complete suite. Hosted macOS missed
the existing 1,000,000-pairs/sec benchmark (742,221 measured); the test and threshold
are unchanged. Passing Ubuntu CI is not a performance claim for every Mac.

Runtime binding helper: `/Users/aaronwhaley/Agent-Corporation/factory/project-runtimes/conversational-memory-system/bindings.py`. Interface: `create --project-root <delivered-checkout> --output <new-private-directory>`. Use returned immutable runtime/holdout scenarios with the native verifier; do not reuse scopes after failure/retry. Candidate source SHA and measured process identity must agree. Teardown requires the same invocation and nonce plus exited child evidence.

Activation remains observation-only until native healthy/defect/wrong-identity/holdout calibration, exact GitHub check mapping and a supervised coding pilot pass. No merge or deploy is implied.

Limits: Live memory corpus, actual Claude/Codex/Hermes history, daemon/LaunchAgents, relay/keychain, external models and ONNX golden coverage without its pinned fixtures.
