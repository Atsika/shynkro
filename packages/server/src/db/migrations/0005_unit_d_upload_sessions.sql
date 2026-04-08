-- Unit D1: chunked + resumable binary upload sessions
--
-- Replaces the single-shot PUT /blob path for files larger than the client's
-- CHUNK_THRESHOLD with a multi-step session protocol. The chunks themselves
-- live on disk under <SHYNKRO_BLOB_DIR>/.upload-sessions/<id>/<index>.bin —
-- this table just holds the session metadata and lets the expireUploadSessions
-- job clean up abandoned sessions safely.

CREATE TABLE "upload_sessions" (
  "id" text PRIMARY KEY NOT NULL,
  "workspace_id" text NOT NULL,
  "file_id" text NOT NULL,
  "user_id" text NOT NULL,
  "total_size" integer NOT NULL,
  "chunk_size" integer NOT NULL,
  "total_chunks" integer NOT NULL,
  "expected_sha256" text NOT NULL,
  "file_name" text,
  "expires_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "upload_sessions" ADD CONSTRAINT "upload_sessions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "upload_sessions" ADD CONSTRAINT "upload_sessions_file_id_file_entries_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."file_entries"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "upload_sessions" ADD CONSTRAINT "upload_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "upload_sessions_expires_at_idx" ON "upload_sessions" USING btree ("expires_at");
--> statement-breakpoint
CREATE INDEX "upload_sessions_workspace_id_idx" ON "upload_sessions" USING btree ("workspace_id");
