// Plain-.mjs worker bootstrap. It loads natively (no TypeScript loader needed for this entry), then
// uses tsx's on-demand `tsImport` to pull in the shared .ts pairing core. This sidesteps the fact
// that a .ts worker entry is picked up by Node's native type-stripping, which does not remap the
// project's ".js" import specifiers to ".ts" the way tsx does.
import { parentPort, workerData } from "node:worker_threads";
import { readFileSync } from "node:fs";
import { tsImport } from "tsx/esm/api";

const { buildTraceIndex, collectTracePartials } = await tsImport("./trace-candidate-core.ts", import.meta.url);

const input = workerData;
const termsBySummary = JSON.parse(readFileSync(input.termsFilePath, "utf8"));
const { termSetsBySummary, postingsByTerm } = buildTraceIndex(termsBySummary, input.maxDocumentFrequency);
const partials = collectTracePartials({
  termsBySummary,
  termSetsBySummary,
  postingsByTerm,
  namespaceSuffix: input.namespaceSuffix,
  idNamespace: input.idNamespace,
  leftStart: input.leftStart,
  leftEnd: input.leftEnd
});

const encoded = {};
for (const [traceId, candidate] of partials) {
  encoded[traceId] = {
    title: candidate.title,
    summaryIndices: [...candidate.summaryIndices],
    keywords: [...candidate.keywords],
    continuityTerms: [...candidate.continuityTerms]
  };
}

parentPort.postMessage(encoded);
