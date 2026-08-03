import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    /**
     * Vitest's default is 5 s. Several tests here are genuinely heavy by design -- they drive real
     * SQLite files, real ONNX sessions, real Argon2id derivations, and real multi-hundred-file
     * imports -- and under the default 16-way parallelism they land near that ceiling and fail
     * intermittently while passing in isolation. Five files had accumulated ad-hoc per-test
     * timeouts for this, which is a worse outcome than one honest global: it hides which tests are
     * heavy and leaves the next one to be discovered by a red CI run.
     *
     * This does NOT mask slow tests. A test that genuinely hangs still fails, and per-test
     * `it(..., timeout)` overrides still win where a tighter bound is the actual assertion.
     */
    testTimeout: 30_000
  }
});
