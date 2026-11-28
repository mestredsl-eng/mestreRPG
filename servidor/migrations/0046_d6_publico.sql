PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_internet_denuncias` (
	`id` text PRIMARY KEY NOT NULL,
	`campaign_id` text NOT NULL,
	`publicacao_id` text NOT NULL,
	`denunciante_conta_id` text,
	`denunciante_ref` text NOT NULL,
	`motivo` text NOT NULL,
	`denuncia_grave` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'aberta' NOT NULL,
	`resolucao` text,
	`resolvido_por` text,
	`prazo_contestacao_em` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`publicacao_id`) REFERENCES `internet_publicacoes`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`denunciante_conta_id`) REFERENCES `internet_accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_internet_denuncias`("id", "campaign_id", "publicacao_id", "denunciante_conta_id", "denunciante_ref", "motivo", "denuncia_grave", "status", "resolucao", "resolvido_por", "prazo_contestacao_em", "created_at", "updated_at") SELECT "id", "campaign_id", "publicacao_id", "denunciante_conta_id", "denunciante_conta_id", "motivo", "denuncia_grave", "status", "resolucao", "resolvido_por", "prazo_contestacao_em", "created_at", "updated_at" FROM `internet_denuncias`;--> statement-breakpoint
DROP TABLE `internet_denuncias`;--> statement-breakpoint
ALTER TABLE `__new_internet_denuncias` RENAME TO `internet_denuncias`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `internet_denuncias_par_idx` ON `internet_denuncias` (`publicacao_id`,`denunciante_ref`);--> statement-breakpoint
CREATE INDEX `internet_denuncias_pub_idx` ON `internet_denuncias` (`publicacao_id`,`status`);--> statement-breakpoint
CREATE INDEX `internet_denuncias_campaign_idx` ON `internet_denuncias` (`campaign_id`);--> statement-breakpoint
CREATE TABLE `__new_internet_pages` (
	`id` text PRIMARY KEY NOT NULL,
	`site_id` text NOT NULL,
	`campaign_id` text NOT NULL,
	`slug` text NOT NULL,
	`titulo` text NOT NULL,
	`corpo` text NOT NULL,
	`formato` text DEFAULT 'texto' NOT NULL,
	`status` text DEFAULT 'publicado' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`autor_conta_id` text,
	`published_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`site_id`) REFERENCES `internet_sites`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`autor_conta_id`) REFERENCES `internet_accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_internet_pages`("id", "site_id", "campaign_id", "slug", "titulo", "corpo", "formato", "status", "version", "autor_conta_id", "published_at", "created_at", "updated_at") SELECT "id", "site_id", "campaign_id", "slug", "titulo", "corpo", "formato", "status", "version", "autor_conta_id", "published_at", "created_at", "updated_at" FROM `internet_pages`;--> statement-breakpoint
DROP TABLE `internet_pages`;--> statement-breakpoint
ALTER TABLE `__new_internet_pages` RENAME TO `internet_pages`;--> statement-breakpoint
CREATE UNIQUE INDEX `internet_pages_slug_idx` ON `internet_pages` (`site_id`,`slug`);--> statement-breakpoint
CREATE INDEX `internet_pages_site_idx` ON `internet_pages` (`site_id`,`status`);--> statement-breakpoint
CREATE INDEX `internet_pages_campaign_idx` ON `internet_pages` (`campaign_id`);--> statement-breakpoint
CREATE TABLE `__new_internet_sites` (
	`id` text PRIMARY KEY NOT NULL,
	`campaign_id` text NOT NULL,
	`slug` text NOT NULL,
	`nome` text NOT NULL,
	`descricao` text,
	`owner_conta_id` text,
	`status` text DEFAULT 'ativo' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`owner_conta_id`) REFERENCES `internet_accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_internet_sites`("id", "campaign_id", "slug", "nome", "descricao", "owner_conta_id", "status", "created_at", "updated_at") SELECT "id", "campaign_id", "slug", "nome", "descricao", "owner_conta_id", "status", "created_at", "updated_at" FROM `internet_sites`;--> statement-breakpoint
DROP TABLE `internet_sites`;--> statement-breakpoint
ALTER TABLE `__new_internet_sites` RENAME TO `internet_sites`;--> statement-breakpoint
CREATE UNIQUE INDEX `internet_sites_slug_idx` ON `internet_sites` (`campaign_id`,`slug`);--> statement-breakpoint
CREATE INDEX `internet_sites_campaign_idx` ON `internet_sites` (`campaign_id`);--> statement-breakpoint
ALTER TABLE `internet_publicacoes` ADD `autor_anon_ref` text;