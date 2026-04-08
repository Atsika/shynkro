-- Unit C1: soft-delete collaborative docs
--
-- Adds a deleted_at timestamp to collaborative_docs so that deleting a file
-- entry no longer risks silently losing its collaborative history. When a
-- file is deleted, the associated doc is marked with deleted_at = NOW();
-- the existing FK cascade on yjs_updates.doc_id still applies but only fires
-- when the purgeDeletedDocs job hard-deletes the parent row, which happens
-- after a 30-day recovery window.
--
-- Recovery procedure: UPDATE collaborative_docs SET deleted_at = NULL
-- WHERE id = '<doc_id>'; the file_entries row can be undeleted with the
-- matching UPDATE on that table.

ALTER TABLE "collaborative_docs" ADD COLUMN "deleted_at" timestamp with time zone;
