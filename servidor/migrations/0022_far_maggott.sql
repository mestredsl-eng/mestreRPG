DROP INDEX `operacao_estorno_op_idx`;--> statement-breakpoint
CREATE UNIQUE INDEX `operacao_estorno_char_op_idx` ON `operacao_estornos` (`campaign_id`,`character_id`,`operacao_id`);