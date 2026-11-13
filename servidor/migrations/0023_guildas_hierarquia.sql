CREATE TABLE `guild_members` (
	`id` text PRIMARY KEY NOT NULL,
	`guild_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text DEFAULT 'membro' NOT NULL,
	`status` text DEFAULT 'ativo' NOT NULL,
	`joined_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`guild_id`) REFERENCES `guilds`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `guild_members_guild_user_idx` ON `guild_members` (`guild_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `guild_members_user_idx` ON `guild_members` (`user_id`);--> statement-breakpoint
CREATE TABLE `guilds` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`status` text DEFAULT 'ativa' NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `guilds_name_idx` ON `guilds` (`name`);--> statement-breakpoint
ALTER TABLE `audit_logs` ADD `guild_id` text REFERENCES guilds(id);--> statement-breakpoint
ALTER TABLE `campaigns` ADD `guild_id` text REFERENCES guilds(id);--> statement-breakpoint
-- Multi-ADMIN (Issue #65): conceder/revogar is_admin passa a ser possível
-- via UPDATE, sempre mediado pela API (somente o ADMIN principal concede,
-- com auditoria). O trigger continua protegendo a identidade raiz:
-- o admin_principal nunca pode ser rebaixado nem ter o id alterado, e
-- não se cria um segundo admin quando não há identidade protegida.
DROP TRIGGER `trg_users_admin_update`;--> statement-breakpoint
CREATE TRIGGER `trg_users_admin_update`
BEFORE UPDATE ON `users`
WHEN
  (EXISTS (SELECT 1 FROM `admin_principal`)
    AND OLD.`id` = (SELECT `user_id` FROM `admin_principal`)
    AND (NEW.`is_admin` = 0 OR NEW.`id` != OLD.`id`))
  OR (NEW.`is_admin` = 1
      AND NOT EXISTS (SELECT 1 FROM `admin_principal`)
      AND EXISTS (SELECT 1 FROM `users` WHERE `is_admin` = 1 AND `id` != OLD.`id`))
BEGIN SELECT RAISE(ABORT, 'privilégio administrativo protegido'); END;
