/** Compatibility CLI removal date. These wrappers are not a privileged Hermes path. */
export const HERMES_WRAPPER_REMOVAL_DATE = "2026-12-05";

export const HERMES_WRAPPER_DEPRECATION =
  `hermes:ingest, hermes:inject, and hermes:resume are thin local MCP clients. ` +
  `Person and scope come from the named profile. hermes:inject is read-only search, not injection. ` +
  `Remove these wrappers after ${HERMES_WRAPPER_REMOVAL_DATE}.`;
