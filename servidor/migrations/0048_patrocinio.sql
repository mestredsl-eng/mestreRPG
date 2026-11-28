CREATE TABLE `internet_patrocinios` (
	`id` text PRIMARY KEY NOT NULL,
	`campaign_id` text NOT NULL,
	`proponente_character_id` text NOT NULL,
	`pagador_character_id` text NOT NULL,
	`beneficiario_character_id` text NOT NULL,
	`pagador_account_id` text NOT NULL,
	`beneficiario_account_id` text,
	`amount_cents` integer NOT NULL,
	`currency` text DEFAULT 'BRL' NOT NULL,
	`condicao_tipo` text NOT NULL,
	`condicao_json` text DEFAULT '{}' NOT NULL,
	`estado` text DEFAULT 'proposto' NOT NULL,
	`proposta_request_id` text,
	`liquidacao_request_id` text,
	`proposto_em` integer NOT NULL,
	`aceito_em` integer,
	`aceito_por` text,
	`cancelado_em` integer,
	`cancelado_por` text,
	`expires_at` integer,
	`liquidado_em` integer,
	`falha_motivo` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`proponente_character_id`) REFERENCES `characters`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`pagador_character_id`) REFERENCES `characters`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`beneficiario_character_id`) REFERENCES `characters`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`pagador_account_id`) REFERENCES `financial_accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`beneficiario_account_id`) REFERENCES `financial_accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`aceito_por`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`cancelado_por`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `internet_patrocinios_campaign_idx` ON `internet_patrocinios` (`campaign_id`,`estado`);--> statement-breakpoint
CREATE INDEX `internet_patrocinios_pagador_idx` ON `internet_patrocinios` (`pagador_character_id`);--> statement-breakpoint
CREATE INDEX `internet_patrocinios_beneficiario_idx` ON `internet_patrocinios` (`beneficiario_character_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `internet_patrocinios_prop_req_idx` ON `internet_patrocinios` (`campaign_id`,`proposta_request_id`);