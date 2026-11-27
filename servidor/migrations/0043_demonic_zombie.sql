CREATE TABLE `internet_pages` (
	`id` text PRIMARY KEY NOT NULL,
	`site_id` text NOT NULL,
	`campaign_id` text NOT NULL,
	`slug` text NOT NULL,
	`titulo` text NOT NULL,
	`corpo` text NOT NULL,
	`formato` text DEFAULT 'texto' NOT NULL,
	`status` text DEFAULT 'publicado' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`autor_conta_id` text NOT NULL,
	`published_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`site_id`) REFERENCES `internet_sites`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`autor_conta_id`) REFERENCES `internet_accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `internet_pages_slug_idx` ON `internet_pages` (`site_id`,`slug`);--> statement-breakpoint
CREATE INDEX `internet_pages_site_idx` ON `internet_pages` (`site_id`,`status`);--> statement-breakpoint
CREATE INDEX `internet_pages_campaign_idx` ON `internet_pages` (`campaign_id`);--> statement-breakpoint
CREATE TABLE `internet_sites` (
	`id` text PRIMARY KEY NOT NULL,
	`campaign_id` text NOT NULL,
	`slug` text NOT NULL,
	`nome` text NOT NULL,
	`descricao` text,
	`owner_conta_id` text NOT NULL,
	`status` text DEFAULT 'ativo' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`owner_conta_id`) REFERENCES `internet_accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `internet_sites_slug_idx` ON `internet_sites` (`campaign_id`,`slug`);--> statement-breakpoint
CREATE INDEX `internet_sites_campaign_idx` ON `internet_sites` (`campaign_id`);