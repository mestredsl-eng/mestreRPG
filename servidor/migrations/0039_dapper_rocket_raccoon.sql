CREATE TABLE `internet_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`campaign_id` text NOT NULL,
	`character_id` text NOT NULL,
	`handle` text NOT NULL,
	`display_name` text,
	`status` text DEFAULT 'ativa' NOT NULL,
	`mostrar_presenca` integer DEFAULT false NOT NULL,
	`mostrar_digitando` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`character_id`) REFERENCES `characters`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `internet_accounts_handle_idx` ON `internet_accounts` (`campaign_id`,`handle`);--> statement-breakpoint
CREATE UNIQUE INDEX `internet_accounts_char_idx` ON `internet_accounts` (`character_id`);--> statement-breakpoint
CREATE INDEX `internet_accounts_campaign_idx` ON `internet_accounts` (`campaign_id`);--> statement-breakpoint
CREATE TABLE `internet_contacts` (
	`id` text PRIMARY KEY NOT NULL,
	`campaign_id` text NOT NULL,
	`conta_origem_id` text NOT NULL,
	`conta_destino_id` text NOT NULL,
	`status` text DEFAULT 'pendente' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`responded_at` integer,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`conta_origem_id`) REFERENCES `internet_accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`conta_destino_id`) REFERENCES `internet_accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `internet_contacts_aresta_idx` ON `internet_contacts` (`campaign_id`,`conta_origem_id`,`conta_destino_id`);--> statement-breakpoint
CREATE INDEX `internet_contacts_origem_idx` ON `internet_contacts` (`conta_origem_id`);--> statement-breakpoint
CREATE INDEX `internet_contacts_destino_idx` ON `internet_contacts` (`conta_destino_id`);--> statement-breakpoint
CREATE TABLE `internet_conversations` (
	`id` text PRIMARY KEY NOT NULL,
	`campaign_id` text NOT NULL,
	`tipo` text NOT NULL,
	`par_key` text,
	`nome` text,
	`status` text DEFAULT 'ativa' NOT NULL,
	`created_by_conta_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_conta_id`) REFERENCES `internet_accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `internet_conv_par_idx` ON `internet_conversations` (`campaign_id`,`par_key`);--> statement-breakpoint
CREATE INDEX `internet_conv_campaign_idx` ON `internet_conversations` (`campaign_id`);--> statement-breakpoint
CREATE TABLE `internet_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`conversa_id` text NOT NULL,
	`campaign_id` text NOT NULL,
	`autor_conta_id` text NOT NULL,
	`request_id` text NOT NULL,
	`payload_hash` text NOT NULL,
	`conteudo` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`conversa_id`) REFERENCES `internet_conversations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`autor_conta_id`) REFERENCES `internet_accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `internet_msg_idem_idx` ON `internet_messages` (`conversa_id`,`autor_conta_id`,`request_id`);--> statement-breakpoint
CREATE INDEX `internet_msg_conv_ordem_idx` ON `internet_messages` (`conversa_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `internet_msg_campaign_idx` ON `internet_messages` (`campaign_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `internet_participantes` (
	`id` text PRIMARY KEY NOT NULL,
	`conversa_id` text NOT NULL,
	`conta_id` text NOT NULL,
	`papel` text DEFAULT 'membro' NOT NULL,
	`status` text DEFAULT 'convidado' NOT NULL,
	`convidado_por_conta_id` text,
	`convidado_em` integer,
	`decidido_em` integer,
	`saiu_em` integer,
	`last_read_created_at` integer,
	`last_read_message_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`conversa_id`) REFERENCES `internet_conversations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`conta_id`) REFERENCES `internet_accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`convidado_por_conta_id`) REFERENCES `internet_accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `internet_part_conv_conta_idx` ON `internet_participantes` (`conversa_id`,`conta_id`);--> statement-breakpoint
CREATE INDEX `internet_part_conta_idx` ON `internet_participantes` (`conta_id`);--> statement-breakpoint
CREATE INDEX `internet_part_status_idx` ON `internet_participantes` (`conversa_id`,`status`);