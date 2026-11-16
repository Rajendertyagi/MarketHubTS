CREATE TABLE `provider_credentials` (
	`provider` text NOT NULL,
	`name` text NOT NULL,
	`format_version` integer NOT NULL,
	`nonce` text NOT NULL,
	`ciphertext` text NOT NULL,
	`tag` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `provider_credentials_identity_uq` ON `provider_credentials` (`provider`,`name`);