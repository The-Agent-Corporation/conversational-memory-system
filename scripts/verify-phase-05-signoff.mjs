import { readFile } from "node:fs/promises";

const REQUIREMENTS = ["REQ-023", "REQ-025", "REQ-027", "REQ-028", "REQ-029"];

export const verifyVitestJson = (value) => {
  assertObject(value, "Vitest result");
  if (value.success !== true) fail("Vitest success must be true");
  for (const field of ["numTotalTests", "numFailedTests", "numPendingTests", "numTodoTests"]) {
    if (typeof value[field] !== "number" || !Number.isInteger(value[field])) {
      fail(`Vitest ${field} must be an integer`);
    }
  }
  if (value.numTotalTests <= 0 || value.numFailedTests !== 0 ||
      value.numPendingTests !== 0 || value.numTodoTests !== 0) {
    fail("Vitest result is empty or non-green");
  }
  if (!Array.isArray(value.testResults) || value.testResults.length === 0) {
    fail("Vitest testResults must be a nonempty array");
  }
  const assertions = [];
  for (const result of value.testResults) {
    assertObject(result, "Vitest test result");
    if (!Array.isArray(result.assertionResults)) fail("Vitest assertionResults must be an array");
    assertions.push(...result.assertionResults);
  }
  if (assertions.length !== value.numTotalTests) fail("Vitest assertion count mismatch");
  for (const assertion of assertions) {
    assertObject(assertion, "Vitest assertion");
    if (assertion.status !== "passed") fail("Vitest contains a non-passed assertion");
  }
};

export const verifyValidationMarkdown = (markdown) => {
  if (typeof markdown !== "string") fail("Validation Markdown must be text");
  const frontmatterMatch = markdown.match(/^---\n([\s\S]*?)\n---\n/);
  if (!frontmatterMatch) fail("Validation frontmatter is malformed");
  const frontmatter = parseFlatYaml(frontmatterMatch[1]);
  if (frontmatter.status !== "complete" || frontmatter.nyquist_compliant !== "true" ||
      frontmatter.final_sign_off !== "approved") {
    fail("Validation frontmatter is not complete and approved");
  }

  const heading = "## Per-Task Verification Map";
  const headingIndex = markdown.split("\n").findIndex((line) => line.trim() === heading);
  if (headingIndex < 0) fail("Per-Task Verification Map is missing");
  const remainingLines = markdown.split("\n").slice(headingIndex + 1);
  const nextHeadingIndex = remainingLines.findIndex((line) => /^##\s/.test(line));
  const sectionLines = nextHeadingIndex < 0
    ? remainingLines
    : remainingLines.slice(0, nextHeadingIndex);
  const tableLines = sectionLines.filter((line) => line.trim().startsWith("|"));
  if (tableLines.length < 3) fail("Verification table is malformed");
  const header = parseRow(tableLines[0]);
  const requirementIndex = header.indexOf("Requirement");
  const statusIndex = header.indexOf("Status");
  if (requirementIndex < 0 || statusIndex < 0) fail("Verification table columns are missing");
  const rows = tableLines.slice(2).map(parseRow);
  for (const requirement of REQUIREMENTS) {
    const matches = rows.filter((row) => row[requirementIndex] === requirement);
    if (matches.length !== 1) fail(`Requirement ${requirement} must have exactly one row`);
    if (matches[0][statusIndex] !== "✅ green") fail(`Requirement ${requirement} is not green`);
  }

  const approvalMatches = [...markdown.matchAll(/^\*\*Approval:\*\*\s*(\S.*?)\s*$/gm)];
  if (approvalMatches.length !== 1 || !approvalMatches[0][1] ||
      approvalMatches[0][1].trim().toLowerCase() === "pending") {
    fail("Standalone Approval must be non-pending");
  }
};

const parseRow = (line) => line.trim().slice(1, -1).split("|").map((cell) => cell.trim());

const parseFlatYaml = (text) => Object.fromEntries(text.split("\n").map((line) => {
  const match = line.match(/^([a-zA-Z0-9_-]+):\s*(.*?)\s*$/);
  return match ? [match[1], match[2].replace(/^['"]|['"]$/g, "")] : ["", ""];
}).filter(([key]) => key));

const assertObject = (value, label) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
};

const fail = (message) => { throw new Error(message); };
const expectFailure = (operation) => {
  let failed = false;
  try { operation(); } catch { failed = true; }
  if (!failed) fail("Self-test expected a fail-closed result");
};

const validVitest = () => ({
  success: true,
  numTotalTests: 2,
  numFailedTests: 0,
  numPendingTests: 0,
  numTodoTests: 0,
  testResults: [{ assertionResults: [{ status: "passed" }, { status: "passed" }] }]
});

const validValidation = () => `---
status: complete
nyquist_compliant: true
final_sign_off: approved
---
## Per-Task Verification Map

| Requirement | Status |
|---|---|
${REQUIREMENTS.map((requirement) => `| ${requirement} | ✅ green |`).join("\n")}

Legend prose says ⬜ pending and ✅ green but cannot affect the table.

## Validation Sign-Off

- [ ] pending prose is intentionally ignored

**Approval:** approved
`;

const runSelfTest = () => {
  verifyVitestJson(validVitest());
  for (const mutate of [
    (value) => { delete value.success; },
    (value) => { value.numTotalTests = "2"; },
    (value) => { value.numFailedTests = 1; },
    (value) => { value.numPendingTests = 1; },
    (value) => { value.numTodoTests = 1; },
    (value) => { value.testResults[0].assertionResults[0].status = "skipped"; },
    (value) => { value.numTotalTests = 3; },
    (value) => { delete value.testResults[0].assertionResults; }
  ]) {
    const fixture = validVitest();
    mutate(fixture);
    expectFailure(() => verifyVitestJson(fixture));
  }

  verifyValidationMarkdown(validValidation());
  for (const invalid of [
    validValidation().replace("| REQ-027 | ✅ green |", ""),
    validValidation().replace("| REQ-027 | ✅ green |", "| REQ-027 | ✅ green |\n| REQ-027 | ✅ green |"),
    validValidation().replace("| REQ-027 | ✅ green |", "| REQ-027 | ⬜ pending |"),
    validValidation().replace(/^---/, "--"),
    validValidation().replace("final_sign_off: approved", "final_sign_off: pending"),
    validValidation().replace("**Approval:** approved", "**Approval:** pending")
  ]) expectFailure(() => verifyValidationMarkdown(invalid));
};

const main = async () => {
  const [mode, path, ...rest] = process.argv.slice(2);
  if (rest.length > 0) fail("Unexpected signoff arguments");
  if (mode === "--self-test" && path === undefined) {
    runSelfTest();
  } else if (mode === "--vitest-json" && path) {
    verifyVitestJson(JSON.parse(await readFile(path, "utf8")));
  } else if (mode === "--validation" && path) {
    verifyValidationMarkdown(await readFile(path, "utf8"));
  } else {
    fail("Select exactly one signoff verification mode");
  }
  process.stdout.write("PHASE_05_SIGNOFF_OK\n");
};

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(() => {
    process.stderr.write("PHASE_05_SIGNOFF_FAILED\n");
    process.exitCode = 1;
  });
}
