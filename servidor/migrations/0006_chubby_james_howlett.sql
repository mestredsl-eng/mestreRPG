ALTER TABLE `rolls` ADD `request_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `rolls_request_idx` ON `rolls` (`campaign_id`,`request_id`);--> statement-breakpoint
ALTER TABLE `sessions` ADD `timer_state` text;--> statement-breakpoint
ALTER TABLE `tests` ADD `request_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `tests_request_idx` ON `tests` (`campaign_id`,`request_id`);