# Changelog

## [0.2.0] - 2026-10-21

### Added

- **Recycle-bin panel** behind a sidebar-footer button. The button carries a count
  badge; the panel lists every entry with its size and deletion time and offers
  restore, delete-forever, and empty-the-bin (the last one needs a second click).

## [0.1.0] - 2026-10-19

### Added

- **Delete conversation** action in the session row's `…` menu, with a confirmation
  dialog that previews the title and the subagent sessions going with it.
- **Soft delete**: the session is archived (which stops running work), its log
  directory moves to `~/.dsh/session-trash/`, and an entry is recorded in an atomic
  index file.
- **8-second undo** toast, plus `restore` and `purge` HTTP routes for later recovery.
- **Subagent cascade** and **fork preservation**.
- Windows file-lock handling: backoff retries at delete time and a startup sweep that
  finishes a move recorded as `moved: false`.
- Three test entry points: `smoke`, `client-shape`, `dry-run`.

### Fixed

- Session ids carry a `session-` prefix end to end; the host used to strip it and then
  fail to resolve the session in the Workspace registry. Ids are now repaired, never
  re-derived.
- A delete whose move failed is retried instead of being reported as already done.
- The client no longer claims a clean delete when the host could only archive the row.

### Known limits

- The trashed conversation remains visible under *show archived* until the next start.
- Purging has no settings UI yet.