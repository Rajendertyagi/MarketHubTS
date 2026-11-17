CREATE TABLE `streaming_subscriptions` (
	`canonical_id` text PRIMARY KEY NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `streaming_subscriptions_enabled_idx` ON `streaming_subscriptions` (`enabled`);