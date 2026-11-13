CREATE TABLE `rule_book_backups` (
	`id` text PRIMARY KEY NOT NULL,
	`book_id` text NOT NULL,
	`snapshot` text NOT NULL,
	`motivo` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`book_id`) REFERENCES `rule_books`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `rule_book_backups_book_idx` ON `rule_book_backups` (`book_id`);--> statement-breakpoint
CREATE TABLE `rule_book_items` (
	`id` text PRIMARY KEY NOT NULL,
	`book_id` text NOT NULL,
	`kind` text NOT NULL,
	`key` text NOT NULL,
	`name` text NOT NULL,
	`category` text,
	`parent_key` text,
	`definition` text DEFAULT '{}' NOT NULL,
	`ordem` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`book_id`) REFERENCES `rule_books`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `rule_book_items_book_kind_key_idx` ON `rule_book_items` (`book_id`,`kind`,`key`);--> statement-breakpoint
CREATE INDEX `rule_book_items_book_idx` ON `rule_book_items` (`book_id`);--> statement-breakpoint
CREATE TABLE `rule_books` (
	`id` text PRIMARY KEY NOT NULL,
	`titulo` text NOT NULL,
	`descricao` text,
	`autor` text,
	`sistema` text,
	`edicao` text,
	`tipo` text DEFAULT 'livro' NOT NULL,
	`versao` integer DEFAULT 1 NOT NULL,
	`formato_versao` integer DEFAULT 1 NOT NULL,
	`origem` text DEFAULT 'manual' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `rule_books_titulo_idx` ON `rule_books` (`titulo`);