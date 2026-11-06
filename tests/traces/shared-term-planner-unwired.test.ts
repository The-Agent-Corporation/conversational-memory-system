import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NullTraceProposalPlanner } from "../../src/traces/null-trace-proposal-planner.js";

const FORBIDDEN = /DeterministicTraceProposalPlanner|trace-candidate-core|buildTraceCandidates|parallel-trace-backfill/;

async function typescriptFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return typescriptFiles(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  }));
  return files.flat();
}

describe("shared-term trace planner unwired from the daemon", () => {
  it("returns no proposals and does not read the request", async () => {
    const planner = new NullTraceProposalPlanner();
    const request = new Proxy({
      reviewedAt: "2026-11-05T00:00:00.000Z",
      summaries: [],
      boxes: [],
      anchors: [],
      proposals: [],
      traces: []
    }, {
      get() {
        throw new Error("request was read");
      }
    });
    await expect(planner.proposeTraces(request)).resolves.toEqual({ proposals: [], skippedCandidates: [] });
  });

  it("keeps the shared-term matcher out of src/daemon", async () => {
    const files = await typescriptFiles(join(process.cwd(), "src/daemon"));
    const offenders: string[] = [];
    for (const file of files) {
      const source = await readFile(file, "utf8");
      if (FORBIDDEN.test(source)) offenders.push(file);
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });
});
