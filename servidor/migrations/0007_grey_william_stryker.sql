CREATE TABLE `snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`campaign_id` text NOT NULL,
	`description` text,
	`data` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `snapshots_campaign_idx` ON `snapshots` (`campaign_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `campaigns` ADD `summary` text;--> statement-breakpoint
ALTER TABLE `notes` ADD `kind` text DEFAULT 'diario' NOT NULL;--> statement-breakpoint
ALTER TABLE `notes` ADD `important` integer DEFAULT 0 NOT NULL;