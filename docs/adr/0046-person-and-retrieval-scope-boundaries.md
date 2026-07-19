# ADR 0046: Person and Retrieval-Scope Boundaries

## Status

Accepted

## Context

A universal personal timeline combines histories from many agents and workspaces. Shared storage must not imply that every client, workspace, case, or task may retrieve every memory item. Person ownership alone is insufficient when one person handles unrelated sensitive contexts.

## Decision

Attach a scope to every approved source and propagate it through canonical and derived memory.

- Source approval accepts an explicit `scopeId`; the default is `personal`.
- A source's scope is immutable through ordinary reapproval. Reclassification requires a dedicated future reviewed operation rather than silently changing prior memory.
- Memory sources, canonical events, compatibility turns, and anchors retain the source scope.
- Historical summaries retain the sorted union of every contributing event scope.
- Strict retrieval requires both `personId` and `allowedScopeIds`. Supplying neither is denied by default; supplying only one is invalid.
- A summary is eligible only when it belongs to the requested person and every contributing scope is allowed.
- An anchor is eligible only when its person and scope are allowed.
- A trace or box is eligible only when it belongs to the requested person and every referenced summary is eligible. This prevents derived text from leaking a disallowed dependency.
- Injection packets record the person and normalized scope allow-list used for retrieval audit.
- Legacy unscoped retrieval is an explicit opt-in used only by the existing Hermes compatibility adapter. New generic and MCP clients must use strict retrieval.

## Consequences

- A case, client, workspace, or operational scope cannot surface into another context merely because both belong to one person.
- Mixed-scope summaries remain useful when all contributing scopes are intentionally allowed, but fail closed when any scope is absent.
- Old unowned memory objects are excluded from strict retrieval rather than guessed into a person.
- The future MCP server has a concrete mandatory authorization input for every recall request.
