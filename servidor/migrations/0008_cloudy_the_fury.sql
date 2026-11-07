CREATE TABLE `folders` (
	`id` text PRIMARY KEY NOT NULL,
	`campaign_id` text NOT NULL,
	`parent_id` text,
	`name` text NOT NULL,
	`allow_player_uploads` integer DEFAULT false NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `folders_campaign_idx` ON `folders` (`campaign_id`);--> statement-breakpoint
ALTER TABLE `files` ADD `folder_id` text;--> statement-breakpoint
ALTER TABLE `files` ADD `display_name` text;--> statement-breakpoint
ALTER TABLE `files` ADD `description` text;--> statement-breakpoint
ALTER TABLE `files` ADD `category` text;--> statement-breakpoint
ALTER TABLE `files` ADD `status` text DEFAULT 'aprovado' NOT NULL;--> statement-breakpoint
ALTER TABLE `files` ADD `storage_name` text;--> statement-breakpoint
ALTER TABLE `files` ADD `updated_at` integer;