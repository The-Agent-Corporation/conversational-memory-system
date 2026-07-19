# Phase 5: Generic MCP Interface - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-07-18
**Phase:** 05-generic-mcp-interface
**Areas discussed:** Connection model, Identity and scope, Tool and response design, Mutation approvals

---

## Connection Model

| Question | Options considered | Selected |
|----------|--------------------|----------|
| Primary transport | Local STDIO; STDIO plus localhost HTTP; localhost HTTP | Local STDIO |
| Relationship to daemon | Separate interactive facade; relay through daemon IPC; embed daemon behavior | Separate interactive facade |
| Database selection | Explicit path in MCP registration; product configuration file; automatic discovery | Product configuration file |
| Daemon offline behavior | Interactive operations remain available; read-only fallback; fail unavailable | Interactive operations remain available |

**User's choice:** STDIO clients launch a separate facade, select the database through product configuration, and remain interactively useful while background synchronization is offline.

**Notes:** Localhost HTTP was discussed as a more flexible later transport, not part of the initial choice.

---

## Identity and Scope

| Question | Options considered | Selected |
|----------|--------------------|----------|
| Authorization source | Profile ceiling with per-call narrowing; exact profile scopes; tool-call supplied identity | Exact profile scopes |
| Profile meaning | Workspace/sensitivity context; agent application; individual installation | Workspace/sensitivity context |
| Profile selection | Explicit MCP registration; infer working directory; implicit default | Explicit MCP registration |
| Blocked-match disclosure | Omit details; disclose counts; return redacted labels | Return redacted labels |

**User's choice:** A registration explicitly chooses a workspace/sensitivity profile containing one person and the complete allowed-scope list. Blocked matches may surface as redacted labels.

**Notes:** The redacted-label choice permits limited cross-scope metadata disclosure. CONTEXT.md constrains implementation to configured disclosure-safe aliases so raw sensitive names and content remain isolated.

---

## Tool and Response Design

| Question | Options considered | Selected |
|----------|--------------------|----------|
| Tool organization | Explicit task tools; umbrella workflow tools; resource-style CRUD | Explicit task tools |
| Search versus recall | Search finds and recall prepares context; aliases; lexical versus semantic split | Search finds; recall prepares context |
| Read responses | Structured data plus rendered text; structured only; Markdown only | Structured data plus rendered text |
| Verbatim expansion | Explicit result IDs; entire remembered subject; embed verbatim text in recall | Entire remembered subject |

**User's choice:** Expose narrow task tools with dual structured/rendered responses. Search provides inspectable candidates, recall prepares context, and expansion opens a whole remembered subject.

**Notes:** Subject expansion remains bounded by REQ-023's explicit token budget and must continue across bounded responses when needed.

---

## Mutation Approvals

| Question | Options considered | Selected |
|----------|--------------------|----------|
| Authorization mechanism | Two-step preview/confirmation; host prompt only; external approval | Two-step preview/confirmation |
| Recall-side mutations | Semantically read-only; preserve with approval; preserve while labeled read-only | Semantically read-only |
| Confirmation-token binding | Exact operation and parameters; operation type; entire session | Exact operation and parameters |
| Source deletion | Separate revoke/delete confirmations; combined action; CLI-only deletion | Separate revoke/delete confirmations |

**User's choice:** Server-enforced, exact, single-use confirmations protect mutations. Read tools do not mutate memory. Revocation and deletion remain separate.

**Notes:** MCP host approval prompts remain useful defense in depth but are not treated as the server's only authorization evidence.

---

## the agent's Discretion

- Exact MCP SDK/module layout, configuration syntax, confirmation-token representation and expiry, cursor format, safe-label vocabulary, and response field naming.
- Exact tool names may change during planning if each task and its safety metadata remain explicit.

## Deferred Ideas

- Localhost Streamable HTTP transport.
- Remote or multi-device access and synchronization.
- First-run profile configuration UI and broader packaging.
