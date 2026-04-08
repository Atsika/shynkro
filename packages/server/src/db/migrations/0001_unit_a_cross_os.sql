-- Unit A: cross-OS correctness
--
-- 1. Track POSIX mode bits per file so executable scripts and other mode-bearing
--    files survive sync between collaborators on different machines.
-- 2. Enforce case-insensitive uniqueness on (workspace_id, path) for non-deleted
--    file entries so a Linux pentester cannot create `Finding.md` next to a
--    macOS pentester's `finding.md` (which is the same file on case-insensitive
--    filesystems and silently clobbers).

ALTER TABLE "file_entries" ADD COLUMN "mode" integer;
--> statement-breakpoint
CREATE UNIQUE INDEX "file_entries_ws_path_ci_idx"
  ON "file_entries" USING btree ("workspace_id", lower("path"))
  WHERE "deleted" = false;
