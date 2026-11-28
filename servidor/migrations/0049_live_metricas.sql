CREATE TABLE `internet_ao_vivo` (
	`id` text PRIMARY KEY NOT NULL,
	`campaign_id` text NOT NULL,
	`conta_id` text NOT NULL,
	`personagem_id` text NOT NULL,
	`titulo` text NOT NULL,
	`descricao` text,
	`iniciado_em` integer NOT NULL,
	`expira_em` integer NOT NULL,
	`encerrado_em` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`conta_id`) REFERENCES `internet_accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`personagem_id`) REFERENCES `characters`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `internet_ao_vivo_campaign_idx` ON `internet_ao_vivo` (`campaign_id`,`encerrado_em`);--> statement-breakpoint
CREATE UNIQUE INDEX `internet_ao_vivo_conta_viva_idx` ON `internet_ao_vivo` (`conta_id`) WHERE encerrado_em is null;--> statement-breakpoint
CREATE TABLE `internet_seguidores` (
	`id` text PRIMARY KEY NOT NULL,
	`campaign_id` text NOT NULL,
	`seguidor_conta_id` text NOT NULL,
	`alvo_conta_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`seguidor_conta_id`) REFERENCES `internet_accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`alvo_conta_id`) REFERENCES `internet_accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `internet_seguidores_par_idx` ON `internet_seguidores` (`seguidor_conta_id`,`alvo_conta_id`);--> statement-breakpoint
CREATE INDEX `internet_seguidores_alvo_idx` ON `internet_seguidores` (`alvo_conta_id`);--> statement-breakpoint
ALTER TABLE `internet_publicacoes` ADD `views_count` integer DEFAULT 0 NOT NULL;