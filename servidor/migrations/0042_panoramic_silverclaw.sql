CREATE TABLE `xp_estornos` (
	`id` text PRIMARY KEY NOT NULL,
	`character_id` text NOT NULL,
	`request_id` text NOT NULL,
	`payload_hash` text NOT NULL,
	`resultado` text NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`character_id`) REFERENCES `characters`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `xp_estorno_request_idx` ON `xp_estornos` (`character_id`,`request_id`);