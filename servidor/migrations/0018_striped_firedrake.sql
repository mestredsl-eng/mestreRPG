CREATE TABLE `novidades` (
	`id` text PRIMARY KEY NOT NULL,
	`titulo` text NOT NULL,
	`resumo` text,
	`conteudo` text DEFAULT '' NOT NULL,
	`versao` text,
	`categoria` text DEFAULT 'novidade' NOT NULL,
	`estado` text DEFAULT 'rascunho' NOT NULL,
	`publicado_em` integer,
	`autor_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`autor_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `novidades_estado_publicado_idx` ON `novidades` (`estado`,`publicado_em`);--> statement-breakpoint
CREATE TABLE `novidade_leituras` (
	`id` text PRIMARY KEY NOT NULL,
	`novidade_id` text NOT NULL,
	`user_id` text NOT NULL,
	`lida_em` integer NOT NULL,
	FOREIGN KEY (`novidade_id`) REFERENCES `novidades`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `novidade_leitura_unica_idx` ON `novidade_leituras` (`novidade_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `novidade_leitura_user_idx` ON `novidade_leituras` (`user_id`);