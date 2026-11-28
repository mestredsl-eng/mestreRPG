CREATE TABLE `internet_perfis` (
	`id` text PRIMARY KEY NOT NULL,
	`campaign_id` text NOT NULL,
	`character_id` text NOT NULL,
	`nome_publico` text,
	`descricao` text,
	`avatar_file_id` text,
	`ativado_em` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`character_id`) REFERENCES `characters`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`avatar_file_id`) REFERENCES `files`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `internet_perfis_char_idx` ON `internet_perfis` (`character_id`);--> statement-breakpoint
CREATE INDEX `internet_perfis_campaign_idx` ON `internet_perfis` (`campaign_id`);