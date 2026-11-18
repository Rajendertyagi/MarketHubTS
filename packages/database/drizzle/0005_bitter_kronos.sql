CREATE TABLE `candle_range_notes` (
	`canonical_id` text NOT NULL,
	`interval` text NOT NULL,
	`provider` text NOT NULL,
	`range_start_ms` integer NOT NULL,
	`kind` text NOT NULL,
	`range_end_ms` integer NOT NULL,
	`reason_code` text,
	`reason_json` text NOT NULL,
	`requested_at` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`canonical_id`, `interval`, `provider`, `range_start_ms`, `kind`)
);
--> statement-breakpoint
CREATE TABLE `historical_candles` (
	`canonical_id` text NOT NULL,
	`interval` text NOT NULL,
	`ts_ms` integer NOT NULL,
	`open` real NOT NULL,
	`high` real NOT NULL,
	`low` real NOT NULL,
	`close` real NOT NULL,
	`volume` integer,
	`oi` integer,
	`provider` text NOT NULL,
	`provenance_json` text NOT NULL,
	`received_at` text NOT NULL,
	PRIMARY KEY(`canonical_id`, `interval`, `ts_ms`)
);
--> statement-breakpoint
CREATE INDEX `historical_candles_provider_idx` ON `historical_candles` (`provider`);--> statement-breakpoint
CREATE TABLE `historical_sync_configs` (
	`id` text PRIMARY KEY NOT NULL,
	`canonical_id` text NOT NULL,
	`interval` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`date_range_json` text,
	`schedule_json` text,
	`provider_policy_json` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `historical_sync_configs_instrument_uq` ON `historical_sync_configs` (`canonical_id`,`interval`);--> statement-breakpoint
CREATE INDEX `historical_sync_configs_enabled_idx` ON `historical_sync_configs` (`enabled`);--> statement-breakpoint
CREATE TABLE `option_chain_capture_configs` (
	`id` text PRIMARY KEY NOT NULL,
	`underlying_canonical_id` text NOT NULL,
	`expiry_date` text NOT NULL,
	`strike_range_json` text,
	`capture_enabled` integer DEFAULT true NOT NULL,
	`capture_mode` text NOT NULL,
	`schedule_json` text,
	`streaming_enabled` integer DEFAULT false NOT NULL,
	`provider` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `option_chain_capture_configs_underlying_idx` ON `option_chain_capture_configs` (`underlying_canonical_id`,`expiry_date`);--> statement-breakpoint
CREATE TABLE `option_chain_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`config_id` text,
	`captured_at` text NOT NULL,
	`provider` text NOT NULL,
	`envelope_json` text NOT NULL,
	`provenance_json` text NOT NULL,
	FOREIGN KEY (`config_id`) REFERENCES `option_chain_capture_configs`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `option_chain_snapshots_config_captured_idx` ON `option_chain_snapshots` (`config_id`,`captured_at`);