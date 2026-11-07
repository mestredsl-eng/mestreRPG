CREATE TABLE `financial_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`character_id` text NOT NULL,
	`campaign_id` text NOT NULL,
	`type` text NOT NULL,
	`name` text NOT NULL,
	`institution` text,
	`agency` text,
	`account_number` text,
	`holder` text,
	`currency` text DEFAULT 'BRL' NOT NULL,
	`balance_cents` integer DEFAULT 0 NOT NULL,
	`credit_limit_cents` integer,
	`data` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`character_id`) REFERENCES `characters`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `fin_accounts_char_idx` ON `financial_accounts` (`character_id`);--> statement-breakpoint
CREATE TABLE `item_templates` (
	`id` text PRIMARY KEY NOT NULL,
	`campaign_id` text NOT NULL,
	`name` text NOT NULL,
	`category` text,
	`description` text,
	`data` text DEFAULT '{}' NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `item_templates_camp_idx` ON `item_templates` (`campaign_id`);--> statement-breakpoint
CREATE TABLE `vehicles` (
	`id` text PRIMARY KEY NOT NULL,
	`character_id` text NOT NULL,
	`campaign_id` text NOT NULL,
	`name` text NOT NULL,
	`kind` text,
	`brand` text,
	`model` text,
	`year` integer,
	`color` text,
	`plate` text,
	`serial_number` text,
	`condition` text,
	`value_cents` integer,
	`fuel` text,
	`capacity` text,
	`ownership` text DEFAULT 'propriedade' NOT NULL,
	`data` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`character_id`) REFERENCES `characters`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `vehicles_char_idx` ON `vehicles` (`character_id`);--> statement-breakpoint
ALTER TABLE `money_transactions` ADD `counterparty_character_id` text REFERENCES characters(id);--> statement-breakpoint
ALTER TABLE `money_transactions` ADD `account_id` text REFERENCES financial_accounts(id);--> statement-breakpoint
ALTER TABLE `money_transactions` ADD `amount_cents` integer;--> statement-breakpoint
ALTER TABLE `money_transactions` ADD `balance_before_cents` integer;--> statement-breakpoint
ALTER TABLE `money_transactions` ADD `balance_after_cents` integer;--> statement-breakpoint
ALTER TABLE `money_transactions` ADD `request_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `money_tx_request_idx` ON `money_transactions` (`campaign_id`,`request_id`);