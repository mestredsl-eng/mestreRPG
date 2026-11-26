CREATE TABLE `character_transfers` (
	`id` text PRIMARY KEY NOT NULL,
	`campaign_id` text NOT NULL,
	`character_id` text NOT NULL,
	`from_membership_id` text NOT NULL,
	`to_membership_id` text NOT NULL,
	`status` text DEFAULT 'pendente' NOT NULL,
	`created_at` integer NOT NULL,
	`decided_at` integer,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`character_id`) REFERENCES `characters`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`from_membership_id`) REFERENCES `memberships`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`to_membership_id`) REFERENCES `memberships`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `char_transf_pendente_idx` ON `character_transfers` (`character_id`) WHERE status = 'pendente';--> statement-breakpoint
CREATE INDEX `char_transf_campaign_idx` ON `character_transfers` (`campaign_id`);--> statement-breakpoint
CREATE INDEX `char_transf_to_idx` ON `character_transfers` (`to_membership_id`,`status`);