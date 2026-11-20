CREATE TABLE `mcp_activity` (
	`id` text PRIMARY KEY NOT NULL,
	`operation_id` text NOT NULL,
	`tool_name` text NOT NULL,
	`transport` text NOT NULL,
	`started_at` text NOT NULL,
	`finished_at` text,
	`duration_ms` integer,
	`client_started_at` text,
	`client_finished_at` text,
	`client_name` text,
	`client_version` text,
	`status` text NOT NULL,
	`error_category` text,
	`error_message` text,
	`summary_json` text,
	`data_result_ref` text,
	CONSTRAINT "mcp_activity_status_ck" CHECK("mcp_activity"."status" IN ('started','succeeded','failed','interrupted')),
	CONSTRAINT "mcp_activity_transport_ck" CHECK("mcp_activity"."transport" IN ('HTTP','STDIO')),
	CONSTRAINT "mcp_activity_duration_ck" CHECK("mcp_activity"."duration_ms" IS NULL OR "mcp_activity"."duration_ms" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mcp_activity_operation_uq` ON `mcp_activity` (`operation_id`);--> statement-breakpoint
CREATE INDEX `mcp_activity_started_id_idx` ON `mcp_activity` (`started_at`,`id`);--> statement-breakpoint
CREATE INDEX `mcp_activity_status_idx` ON `mcp_activity` (`status`);--> statement-breakpoint
CREATE INDEX `mcp_activity_tool_idx` ON `mcp_activity` (`tool_name`);--> statement-breakpoint
CREATE INDEX `mcp_activity_transport_idx` ON `mcp_activity` (`transport`);