CREATE TABLE `campaign_rule_books` (
  `id` text PRIMARY KEY NOT NULL,
  `campaign_id` text NOT NULL REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE cascade,
  `book_id` text NOT NULL REFERENCES `rule_books`(`id`) ON UPDATE no action ON DELETE cascade,
  `applied_version` integer NOT NULL,
  `snapshot` text DEFAULT '[]' NOT NULL,
  `applied_at` integer NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `campaign_rule_books_campaign_book_idx` ON `campaign_rule_books` (`campaign_id`, `book_id`);
--> statement-breakpoint
CREATE INDEX `campaign_rule_books_campaign_idx` ON `campaign_rule_books` (`campaign_id`);
