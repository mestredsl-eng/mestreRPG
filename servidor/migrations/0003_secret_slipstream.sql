ALTER TABLE `characters` ADD `overrides` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE `sheet_templates` ADD `campaign_id` text REFERENCES campaigns(id);--> statement-breakpoint
ALTER TABLE `sheet_templates` ADD `is_active` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `sheet_templates` ADD `is_default` integer DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX `sheet_templates_campaign_idx` ON `sheet_templates` (`campaign_id`);