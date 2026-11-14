ALTER TABLE `guilds` ADD `responsible_user_id` text REFERENCES users(id);--> statement-breakpoint
-- Backfill seguro: responsável inicial = created_by SE ainda for GM ativo
-- com conta ativa; senão, o GM ativo mais antigo; senão NULL (guilda sem
-- GM ativo — recuperável apenas via ADMIN, documentado em hierarquia-contas).
UPDATE `guilds` SET `responsible_user_id` = (
  SELECT gm.`user_id` FROM `guild_members` gm
  JOIN `users` u ON u.`id` = gm.`user_id`
  WHERE gm.`guild_id` = `guilds`.`id`
    AND gm.`role` = 'gm'
    AND gm.`status` = 'ativo'
    AND u.`status` = 'ativo'
  ORDER BY CASE WHEN gm.`user_id` = `guilds`.`created_by` THEN 0 ELSE 1 END,
           gm.`joined_at` ASC, gm.`created_at` ASC
  LIMIT 1
);
