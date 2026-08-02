/**
 * Resume identity for an append-only history file.
 *
 * **Never include `st_dev`.** On macOS APFS the device number is assigned at mount time and changes
 * across reboot/remount. On the live corpus every one of 6,758 surviving import checkpoints was
 * invalidated by a single `16777234 -> 16777232` transition with the inodes completely unchanged:
 * `identity_matches` 0, `inode_really_changed` 0. That silently disabled resume for the entire
 * corpus, so each daemon source scan re-read ~9.2 GB of history from offset 0 and imported nothing.
 * The failure is invisible — a checkpoint that does not match simply looks like a new file.
 *
 * `birthtime` covers the only thing `dev` was nominally guarding: inode reuse after a file is
 * deleted and a new file receives its number. A replacement file has a later birthtime, fails the
 * match, and is re-read from offset 0 — the safe direction. Verified on this platform that
 * birthtime is non-zero, distinct from mtime, and stable across appends (an mtime-derived value
 * would change on every append and reintroduce the original bug).
 */

/** Discriminates the current format from legacy `dev:ino` values already in the store. */
export const FILE_IDENTITY_PREFIX = "v2:";

export interface FileIdentityMetadata {
  ino: number;
  birthtimeMs: number;
}

export function composeFileIdentity(metadata: FileIdentityMetadata): string {
  // Truncated to whole milliseconds: `birthtimeMs` carries sub-millisecond float precision, and a
  // value that reformats differently between two stat calls would never compare equal to itself.
  const birthtimeMs = Number.isFinite(metadata.birthtimeMs) ? Math.trunc(metadata.birthtimeMs) : 0;
  return `${FILE_IDENTITY_PREFIX}${metadata.ino}:${birthtimeMs}`;
}

/**
 * Whether a stored checkpoint identity still refers to the file that produced it.
 *
 * Legacy `dev:ino` identities are compared **on the inode alone**, deliberately ignoring the stored
 * device number. That is what rescues the existing checkpoints: without it, shipping this change
 * would invalidate all 6,758 of them at once and force exactly the full re-parse it exists to
 * prevent. Importers rewrite the checkpoint in the current format on the next successful pass, so
 * legacy values migrate as they are touched rather than through a migration.
 */
export function fileIdentityMatches(stored: string, metadata: FileIdentityMetadata): boolean {
  if (stored.startsWith(FILE_IDENTITY_PREFIX)) return stored === composeFileIdentity(metadata);
  const parts = stored.split(":");
  if (parts.length !== 2) return false;
  return parts[1] === String(metadata.ino);
}
