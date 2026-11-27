CREATE TABLE `internet_denuncias` (
	`id` text PRIMARY KEY NOT NULL,
	`campaign_id` text NOT NULL,
	`publicacao_id` text NOT NULL,
	`denunciante_conta_id` text NOT NULL,
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
CREATE UNIQUE INDEX `internet_denuncias_par_idx` ON `internet_denuncias` (`publicacao_id`,`denunciante_conta_id`);--> statement-breakpoint
CREATE INDEX `internet_denuncias_pub_idx` ON `internet_denuncias` (`publicacao_id`,`status`);--> statement-breakpoint
CREATE INDEX `internet_denuncias_campaign_idx` ON `internet_denuncias` (`campaign_id`);--> statement-breakpoint
CREATE TABLE `internet_publicacoes` (
	`id` text PRIMARY KEY NOT NULL,
	`campaign_id` text NOT NULL,
	`tipo` text NOT NULL,
	`titulo` text NOT NULL,
	`corpo` text NOT NULL,
	`formato` text DEFAULT 'markdown-subset' NOT NULL,
	`status` text DEFAULT 'rascunho' NOT NULL,
	`visibilidade` text DEFAULT 'campanha' NOT NULL,
	`autor_modo` text DEFAULT 'identificado' NOT NULL,
	`pseudo_nome` text,
	`autor_conta_id` text,
	`origem` text DEFAULT 'usuario' NOT NULL,
	`fonte_ref` text,
	`personagem_id` text,
	`publicado_em` integer,
	`retirado_em` integer,
	`retirado_motivo` text,
	`denuncia_aberta` integer DEFAULT 0 NOT NULL,
	`denuncia_grave` integer DEFAULT 0 NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`autor_conta_id`) REFERENCES `internet_accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`personagem_id`) REFERENCES `characters`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `internet_publicacoes_feed_idx` ON `internet_publicacoes` (`campaign_id`,`tipo`,`status`,`publicado_em`);--> statement-breakpoint
CREATE INDEX `internet_publicacoes_autor_idx` ON `internet_publicacoes` (`autor_conta_id`,`status`);--> statement-breakpoint
CREATE INDEX `internet_publicacoes_personagem_idx` ON `internet_publicacoes` (`personagem_id`);