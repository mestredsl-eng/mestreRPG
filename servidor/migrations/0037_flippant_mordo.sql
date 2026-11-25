DROP INDEX `shop_order_request_idx`;--> statement-breakpoint
-- SQLite exige default não-nulo em ADD COLUMN NOT NULL; os defaults são
-- só para satisfazer a regra do ALTER — o código sempre grava os valores.
ALTER TABLE `shop_orders` ADD `created_by` text NOT NULL DEFAULT '';--> statement-breakpoint
ALTER TABLE `shop_orders` ADD `direction` text NOT NULL DEFAULT 'compra';--> statement-breakpoint
-- Backfill de direção a partir do JSON legado (data.direction), se houver.
UPDATE `shop_orders` SET `direction` = json_extract(`data`, '$.direction') WHERE json_extract(`data`, '$.direction') IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `shop_order_request_idx` ON `shop_orders` (`campaign_id`,`created_by`,`direction`,`request_id`);
