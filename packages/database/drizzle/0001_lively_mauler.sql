CREATE TABLE `canonical_instruments` (
	`canonical_id` text PRIMARY KEY NOT NULL,
	`identity_key` text NOT NULL,
	`identity_version` integer DEFAULT 1 NOT NULL,
	`exchange` text NOT NULL,
	`segment` text NOT NULL,
	`market_type` text NOT NULL,
	`instrument_category` text NOT NULL,
	`canonical_symbol` text NOT NULL,
	`display_name` text NOT NULL,
	`stable_identifier` text,
	`underlying_canonical_id` text,
	`isin` text,
	`exchange_security_id` text,
	`trading_status` text NOT NULL,
	`lifecycle_status` text NOT NULL,
	`derivative_json` text,
	`cash_index_membership_json` text,
	`exchange_derivative_eligibility_json` text,
	`product_scope_json` text,
	`source_meta_json` text,
	`provenance_json` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `canonical_instruments_identity_key_uq` ON `canonical_instruments` (`identity_key`);--> statement-breakpoint
CREATE INDEX `canonical_instruments_exchange_segment_idx` ON `canonical_instruments` (`exchange`,`segment`);--> statement-breakpoint
CREATE INDEX `canonical_instruments_category_idx` ON `canonical_instruments` (`instrument_category`);--> statement-breakpoint
CREATE INDEX `canonical_instruments_symbol_idx` ON `canonical_instruments` (`canonical_symbol`);--> statement-breakpoint
CREATE INDEX `canonical_instruments_isin_idx` ON `canonical_instruments` (`isin`);--> statement-breakpoint
CREATE INDEX `canonical_instruments_exchange_security_id_idx` ON `canonical_instruments` (`exchange_security_id`);--> statement-breakpoint
CREATE INDEX `canonical_instruments_underlying_idx` ON `canonical_instruments` (`underlying_canonical_id`);--> statement-breakpoint
CREATE TABLE `catalog_sync_runs` (
	`run_id` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`provider` text,
	`scope_json` text NOT NULL,
	`completeness` text NOT NULL,
	`status` text NOT NULL,
	`started_at` text NOT NULL,
	`finished_at` text,
	`source_version` text,
	`source_observed_at` text,
	`counts_json` text NOT NULL,
	`conflicts_json` text NOT NULL,
	`error` text,
	`metadata_json` text
);
--> statement-breakpoint
CREATE INDEX `catalog_sync_runs_source_idx` ON `catalog_sync_runs` (`source`);--> statement-breakpoint
CREATE INDEX `catalog_sync_runs_status_idx` ON `catalog_sync_runs` (`status`);--> statement-breakpoint
CREATE INDEX `catalog_sync_runs_started_idx` ON `catalog_sync_runs` (`started_at`);--> statement-breakpoint
CREATE TABLE `derivative_contracts` (
	`canonical_id` text PRIMARY KEY NOT NULL,
	`exchange` text NOT NULL,
	`segment` text NOT NULL,
	`derivative_class` text NOT NULL,
	`underlying_canonical_id` text NOT NULL,
	`expiry_date` text NOT NULL,
	`strike_normalized` text,
	`option_type` text,
	`strike_key` text DEFAULT '' NOT NULL,
	`option_type_key` text DEFAULT '' NOT NULL,
	`lot_size` integer,
	`tick_size` text,
	`quantity_freeze` integer,
	`contract_lifecycle_status` text,
	`contract_source` text,
	`contract_observed_at` text,
	`supplemental_meta_json` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`canonical_id`) REFERENCES `canonical_instruments`(`canonical_id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`underlying_canonical_id`) REFERENCES `canonical_instruments`(`canonical_id`) ON UPDATE cascade ON DELETE restrict,
	CONSTRAINT "derivative_contracts_future_shape_ck" CHECK((
        ("derivative_contracts"."derivative_class" IN ('STOCK_FUTURE','INDEX_FUTURE') AND "derivative_contracts"."strike_normalized" IS NULL AND "derivative_contracts"."option_type" IS NULL AND "derivative_contracts"."strike_key" = '' AND "derivative_contracts"."option_type_key" = '')
        OR
        ("derivative_contracts"."derivative_class" IN ('STOCK_OPTION','INDEX_OPTION') AND "derivative_contracts"."strike_normalized" IS NOT NULL AND "derivative_contracts"."option_type" IN ('CE','PE') AND "derivative_contracts"."strike_key" <> '' AND "derivative_contracts"."option_type_key" IN ('CE','PE') AND CAST("derivative_contracts"."strike_normalized" AS REAL) > 0)
      )),
	CONSTRAINT "derivative_contracts_lot_size_ck" CHECK(("derivative_contracts"."lot_size" IS NULL OR "derivative_contracts"."lot_size" > 0)),
	CONSTRAINT "derivative_contracts_quantity_freeze_ck" CHECK(("derivative_contracts"."quantity_freeze" IS NULL OR "derivative_contracts"."quantity_freeze" > 0)),
	CONSTRAINT "derivative_contracts_tick_size_ck" CHECK(("derivative_contracts"."tick_size" IS NULL OR CAST("derivative_contracts"."tick_size" AS REAL) > 0))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `derivative_contracts_identity_uq` ON `derivative_contracts` (`exchange`,`segment`,`derivative_class`,`underlying_canonical_id`,`expiry_date`,`strike_key`,`option_type_key`);--> statement-breakpoint
CREATE INDEX `derivative_contracts_underlying_idx` ON `derivative_contracts` (`underlying_canonical_id`);--> statement-breakpoint
CREATE INDEX `derivative_contracts_expiry_idx` ON `derivative_contracts` (`expiry_date`);--> statement-breakpoint
CREATE INDEX `derivative_contracts_underlying_expiry_idx` ON `derivative_contracts` (`underlying_canonical_id`,`expiry_date`);--> statement-breakpoint
CREATE INDEX `derivative_contracts_class_idx` ON `derivative_contracts` (`derivative_class`);--> statement-breakpoint
CREATE TABLE `instrument_aliases` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`canonical_id` text NOT NULL,
	`alias` text NOT NULL,
	`alias_normalized` text NOT NULL,
	`alias_type` text NOT NULL,
	`source` text NOT NULL,
	`exchange` text,
	`segment` text,
	`exchange_scope` text DEFAULT '*' NOT NULL,
	`segment_scope` text DEFAULT '*' NOT NULL,
	`status` text NOT NULL,
	`provenance_json` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`canonical_id`) REFERENCES `canonical_instruments`(`canonical_id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `instrument_aliases_uq` ON `instrument_aliases` (`canonical_id`,`alias_normalized`,`alias_type`,`source`,`exchange_scope`,`segment_scope`);--> statement-breakpoint
CREATE INDEX `instrument_aliases_alias_norm_idx` ON `instrument_aliases` (`alias_normalized`);--> statement-breakpoint
CREATE INDEX `instrument_aliases_canonical_idx` ON `instrument_aliases` (`canonical_id`);--> statement-breakpoint
CREATE INDEX `instrument_aliases_scope_idx` ON `instrument_aliases` (`exchange_scope`,`segment_scope`);--> statement-breakpoint
CREATE TABLE `instrument_identifier_history` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`canonical_id` text NOT NULL,
	`identifier_type` text NOT NULL,
	`identifier_namespace` text NOT NULL,
	`identifier_value` text NOT NULL,
	`identifier_normalized` text NOT NULL,
	`exchange` text,
	`segment` text,
	`exchange_scope` text DEFAULT '*' NOT NULL,
	`segment_scope` text DEFAULT '*' NOT NULL,
	`source` text NOT NULL,
	`provenance_json` text,
	`valid_from` text,
	`valid_to` text,
	`status` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`canonical_id`) REFERENCES `canonical_instruments`(`canonical_id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `instrument_identifier_history_canonical_idx` ON `instrument_identifier_history` (`canonical_id`);--> statement-breakpoint
CREATE INDEX `instrument_identifier_history_lookup_idx` ON `instrument_identifier_history` (`identifier_type`,`identifier_namespace`,`identifier_normalized`,`exchange_scope`,`segment_scope`);--> statement-breakpoint
CREATE INDEX `instrument_identifier_history_status_idx` ON `instrument_identifier_history` (`status`);--> statement-breakpoint
CREATE INDEX `instrument_identifier_history_value_idx` ON `instrument_identifier_history` (`identifier_normalized`);--> statement-breakpoint
CREATE UNIQUE INDEX `instrument_identifier_history_current_authoritative_uq` ON `instrument_identifier_history` (`identifier_type`,`identifier_namespace`,`identifier_normalized`,`exchange_scope`,`segment_scope`) WHERE "instrument_identifier_history"."status" = 'CURRENT' AND "instrument_identifier_history"."identifier_type" IN ('ISIN','EXCHANGE_SECURITY_ID','STABLE_ID');--> statement-breakpoint
CREATE TABLE `provider_instrument_mappings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`provider` text NOT NULL,
	`native_identifier` text NOT NULL,
	`canonical_id` text NOT NULL,
	`exchange` text,
	`segment` text,
	`native_symbol` text,
	`native_exchange_token` text,
	`status` text NOT NULL,
	`source_meta_json` text,
	`provenance_json` text,
	`valid_from` text,
	`valid_to` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`canonical_id`) REFERENCES `canonical_instruments`(`canonical_id`) ON UPDATE cascade ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `provider_mappings_provider_native_uq` ON `provider_instrument_mappings` (`provider`,`native_identifier`);--> statement-breakpoint
CREATE INDEX `provider_mappings_canonical_idx` ON `provider_instrument_mappings` (`canonical_id`);--> statement-breakpoint
CREATE INDEX `provider_mappings_provider_idx` ON `provider_instrument_mappings` (`provider`);