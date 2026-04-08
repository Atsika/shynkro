-- Unit B3: op queue idempotency cache
--
-- When an extension crashes between "server applied my mutation" and "client
-- received my ack", the pending_ops queue still holds the op and gets drained
-- on next startup. Without deduplication this created a duplicate file (on
-- create) or a spurious 404 (on delete). The server now stores recent op
-- responses keyed by a client-generated UUID (X-Shynkro-Op-Id) and replays
-- return the cached response instead of re-executing.
--
-- The table is swept every 5 minutes by the purgeRecentOpIds job, which
-- deletes rows older than 24 hours.

CREATE TABLE "recent_op_ids" (
    "workspace_id" text NOT NULL,
    "op_id" text NOT NULL,
    "result" text NOT NULL,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT "recent_op_ids_workspace_id_op_id_pk" PRIMARY KEY("workspace_id","op_id")
);
--> statement-breakpoint
ALTER TABLE "recent_op_ids" ADD CONSTRAINT "recent_op_ids_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "recent_op_ids_created_at_idx" ON "recent_op_ids" USING btree ("created_at");
