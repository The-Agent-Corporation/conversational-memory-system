# Conversational Memory System factory contract

Actual private SQLite store and deterministic source modules; synthetic people/scopes only; no imported agent histories.

Ordinary checks: `python3 harness/ci.py`. GitHub check name: **Factory deterministic checks** (new workflow; requires actual GitHub run readback before readiness binding).

CI selects three disjoint file partitions: portable tests on Ubuntu, macOS adapter
contracts on macOS, and the unchanged retrieval performance benchmark file on
a fresh Ubuntu runner. Vitest discovery verifies the complete file union; the
always-run aggregate fails unless all three jobs succeed, including cancelled
or skipped jobs. The local ordinary command still runs the complete suite.
The benchmark imports its frozen oracle's test module, so those suites execute
again within that file. Portable CI also runs the Python factory regressions.

The shared hosted Linux suite missed the existing 1,000,000-pairs/sec floor at
984,167; hosted macOS previously measured 742,221. The isolated job prints its
machine environment, all benchmark samples and JSON results. No threshold,
clock, test or retry policy is relaxed. Passing one runner is not a performance
claim for every machine; an isolated benchmark failure remains a real failed gate.
ADR 0060 adds a bounded substring-presence filter to reject impossible matches
before exact substring search, preserving the frozen oracle and benchmark.

Runtime binding helper: `/Users/aaronwhaley/Agent-Corporation/factory/project-runtimes/conversational-memory-system/bindings.py`. Interface: `create --project-root <delivered-checkout> --output <new-private-directory>`. Use returned immutable runtime/holdout scenarios with the native verifier; do not reuse scopes after failure/retry. Candidate source SHA and measured process identity must agree. Teardown requires the same invocation and nonce plus exited child evidence.

Activation remains observation-only until native healthy/defect/wrong-identity/holdout calibration, exact GitHub check mapping and a supervised coding pilot pass. No merge or deploy is implied.

Limits: Live memory corpus, actual Claude/Codex/Hermes history, daemon/LaunchAgents, relay/keychain, external models and ONNX golden coverage without its pinned fixtures.

HTTP harness fixtures require POSIX `waitid`/`WNOWAIT` and refuse Windows before launching project code. Windows HTTP fixture execution remains unqualified; the separate runtime ProcessTree Job Object does not qualify HttpApp. Cleanup verifies that no live group members remain; unreaped zombies are already stopped, and unknown membership fails closed.

Scheduled fire revalidates the current merge policy before admission. Invalid declarations produce a policy-validation error and require fixing harness/harness.config.json; schedule install rejects invalid declarations too. A changed effective installed policy refuses launch with a reinstall diagnostic. Explicit schedule overrides retain their install-time meaning, and existing durable runs can still wake after either refusal.
