-- Unit B1: snapshot integrity + halt-on-corrupt
--
-- Every Yjs snapshot written by maybeCompact now carries a SHA-256 of its
-- bytes, re-verified on every loadDoc. A mismatch (or an applyUpdate failure)
-- sets the `corrupted` flag, after which loadDoc throws DocCorruptedError and
-- persistUpdate refuses further writes. This prevents the previous silent
-- data-loss path where a corrupted snapshot returned an empty Y.Doc, which
-- was then saved as the new source of truth on the next edit.

ALTER TABLE "collaborative_docs" ADD COLUMN "snapshot_hash" text;
--> statement-breakpoint
ALTER TABLE "collaborative_docs" ADD COLUMN "corrupted" boolean DEFAULT false NOT NULL;
