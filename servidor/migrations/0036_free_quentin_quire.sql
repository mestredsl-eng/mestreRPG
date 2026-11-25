CREATE TABLE `shop_managers` (
	`id` text PRIMARY KEY NOT NULL,
	`shop_id` text NOT NULL,
	`campaign_id` text NOT NULL,
	`membership_id` text NOT NULL,
	`role` text DEFAULT 'gestor' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`shop_id`) REFERENCES `shops`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`membership_id`) REFERENCES `memberships`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `shop_manager_unico_idx` ON `shop_managers` (`shop_id`,`membership_id`);--> statement-breakpoint
CREATE INDEX `shop_manager_membership_idx` ON `shop_managers` (`membership_id`);--> statement-breakpoint
CREATE TABLE `shop_offers` (
	`id` text PRIMARY KEY NOT NULL,
	`shop_id` text NOT NULL,
	`campaign_id` text NOT NULL,
	`item_template_id` text,
	`name` text NOT NULL,
	`description` text,
	`price_cents` integer NOT NULL,
	`currency` text DEFAULT 'BRL' NOT NULL,
	`stock_qty` integer,
	`is_active` integer DEFAULT true NOT NULL,
	`data` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`shop_id`) REFERENCES `shops`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`item_template_id`) REFERENCES `item_templates`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `shop_offers_shop_idx` ON `shop_offers` (`shop_id`);--> statement-breakpoint
CREATE INDEX `shop_offers_campaign_idx` ON `shop_offers` (`campaign_id`);--> statement-breakpoint
CREATE TABLE `shop_orders` (
	`id` text PRIMARY KEY NOT NULL,
	`campaign_id` text NOT NULL,
	`shop_id` text NOT NULL,
	`request_id` text NOT NULL,
	`buyer_character_id` text NOT NULL,
	`items` text NOT NULL,
	`total_cents` integer NOT NULL,
	`currency` text DEFAULT 'BRL' NOT NULL,
	`status` text DEFAULT 'concluido' NOT NULL,
	`money_transaction_ids` text DEFAULT '[]' NOT NULL,
	`data` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`shop_id`) REFERENCES `shops`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`buyer_character_id`) REFERENCES `characters`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `shop_order_request_idx` ON `shop_orders` (`campaign_id`,`request_id`);--> statement-breakpoint
CREATE INDEX `shop_orders_shop_idx` ON `shop_orders` (`shop_id`);--> statement-breakpoint
CREATE INDEX `shop_orders_buyer_idx` ON `shop_orders` (`buyer_character_id`);--> statement-breakpoint
CREATE TABLE `shops` (
	`id` text PRIMARY KEY NOT NULL,
	`campaign_id` text NOT NULL,
	`name` text NOT NULL,
	`category` text,
	`location` text,
	`description` text,
	`is_open` integer DEFAULT true NOT NULL,
	`data` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `shops_campaign_idx` ON `shops` (`campaign_id`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_financial_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`character_id` text,
	`shop_id` text,
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
	FOREIGN KEY (`shop_id`) REFERENCES `shops`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_financial_accounts`("id", "character_id", "campaign_id", "type", "name", "institution", "agency", "account_number", "holder", "currency", "balance_cents", "credit_limit_cents", "data", "created_at", "updated_at") SELECT "id", "character_id", "campaign_id", "type", "name", "institution", "agency", "account_number", "holder", "currency", "balance_cents", "credit_limit_cents", "data", "created_at", "updated_at" FROM `financial_accounts`;--> statement-breakpoint
DROP TABLE `financial_accounts`;--> statement-breakpoint
ALTER TABLE `__new_financial_accounts` RENAME TO `financial_accounts`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `fin_accounts_char_idx` ON `financial_accounts` (`character_id`);--> statement-breakpoint
CREATE TABLE `__new_money_transactions` (
	`id` text PRIMARY KEY NOT NULL,
	`character_id` text,
	`shop_id` text,
	`campaign_id` text NOT NULL,
	`kind` text NOT NULL,
	`amount` real NOT NULL,
	`currency` text DEFAULT 'BRL' NOT NULL,
	`account` text,
	`counterparty` text,
	`counterparty_character_id` text,
	`account_id` text,
	`description` text,
	`amount_cents` integer,
	`balance_before_cents` integer,
	`balance_after_cents` integer,
	`request_id` text,
	`inventory_item_id` text,
	`operacao` text,
	`created_by` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`character_id`) REFERENCES `characters`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`shop_id`) REFERENCES `shops`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`counterparty_character_id`) REFERENCES `characters`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`account_id`) REFERENCES `financial_accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_money_transactions`("id", "character_id", "campaign_id", "kind", "amount", "currency", "account", "counterparty", "counterparty_character_id", "account_id", "description", "amount_cents", "balance_before_cents", "balance_after_cents", "request_id", "inventory_item_id", "operacao", "created_by", "created_at") SELECT "id", "character_id", "campaign_id", "kind", "amount", "currency", "account", "counterparty", "counterparty_character_id", "account_id", "description", "amount_cents", "balance_before_cents", "balance_after_cents", "request_id", "inventory_item_id", "operacao", "created_by", "created_at" FROM `money_transactions`;--> statement-breakpoint
DROP TABLE `money_transactions`;--> statement-breakpoint
ALTER TABLE `__new_money_transactions` RENAME TO `money_transactions`;--> statement-breakpoint
CREATE INDEX `money_tx_char_idx` ON `money_transactions` (`character_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `money_tx_request_idx` ON `money_transactions` (`campaign_id`,`request_id`);