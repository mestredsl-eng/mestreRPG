CREATE TABLE `admin_principal` (
	`user_id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint

-- Semeia a conta administradora já existente nesta instalação.
-- Em bases novas (sem admin) não insere nada: o primeiro admin criado via
-- /api/auth/setup é registrado automaticamente pelo trigger de INSERT abaixo.
INSERT INTO `admin_principal` (`user_id`, `created_at`)
SELECT `id`, `created_at` FROM `users` WHERE `is_admin` = 1 LIMIT 1;
--> statement-breakpoint

-- admin_principal aceita no máximo um registro, imutável.
CREATE TRIGGER `trg_admin_principal_unico`
BEFORE INSERT ON `admin_principal`
WHEN EXISTS (SELECT 1 FROM `admin_principal`)
BEGIN SELECT RAISE(ABORT, 'admin_principal ja possui registro'); END;
--> statement-breakpoint
CREATE TRIGGER `trg_admin_principal_sem_update`
BEFORE UPDATE ON `admin_principal`
BEGIN SELECT RAISE(ABORT, 'identidade do administrador e imutavel'); END;
--> statement-breakpoint
CREATE TRIGGER `trg_admin_principal_sem_delete`
BEFORE DELETE ON `admin_principal`
BEGIN SELECT RAISE(ABORT, 'identidade do administrador e imutavel'); END;
--> statement-breakpoint

-- INSERT em users: is_admin=1 só para o id protegido; sem proteção registrada,
-- só quando ainda não existe nenhum admin (bootstrap da primeira conta).
CREATE TRIGGER `trg_users_admin_insert`
BEFORE INSERT ON `users`
WHEN NEW.`is_admin` = 1 AND (
  (EXISTS (SELECT 1 FROM `admin_principal`)
    AND NEW.`id` != (SELECT `user_id` FROM `admin_principal`))
  OR
  (NOT EXISTS (SELECT 1 FROM `admin_principal`)
    AND EXISTS (SELECT 1 FROM `users` WHERE `is_admin` = 1))
)
BEGIN SELECT RAISE(ABORT, 'somente a conta administradora original pode ser admin'); END;
--> statement-breakpoint

-- Primeiro admin de uma instalação nova vira a identidade protegida.
CREATE TRIGGER `trg_users_admin_registrar`
AFTER INSERT ON `users`
WHEN NEW.`is_admin` = 1 AND NOT EXISTS (SELECT 1 FROM `admin_principal`)
BEGIN
  INSERT INTO `admin_principal` (`user_id`, `created_at`)
  VALUES (NEW.`id`, NEW.`created_at`);
END;
--> statement-breakpoint

-- UPDATE em users: bloqueia rebaixar admin, promover outro id e trocar o id protegido.
CREATE TRIGGER `trg_users_admin_update`
BEFORE UPDATE ON `users`
WHEN
  (OLD.`is_admin` = 1 AND NEW.`is_admin` = 0)
  OR (NEW.`is_admin` = 1
      AND EXISTS (SELECT 1 FROM `admin_principal`)
      AND NEW.`id` != (SELECT `user_id` FROM `admin_principal`))
  OR (NEW.`is_admin` = 1 AND OLD.`is_admin` = 0
      AND NOT EXISTS (SELECT 1 FROM `admin_principal`)
      AND EXISTS (SELECT 1 FROM `users` WHERE `is_admin` = 1 AND `id` != OLD.`id`))
  OR (EXISTS (SELECT 1 FROM `admin_principal`)
      AND OLD.`id` = (SELECT `user_id` FROM `admin_principal`)
      AND NEW.`id` != OLD.`id`)
BEGIN SELECT RAISE(ABORT, 'privilégio administrativo protegido'); END;
--> statement-breakpoint

-- DELETE em users: a conta protegida não pode ser excluída.
CREATE TRIGGER `trg_users_admin_delete`
BEFORE DELETE ON `users`
WHEN EXISTS (SELECT 1 FROM `admin_principal`)
  AND OLD.`id` = (SELECT `user_id` FROM `admin_principal`)
BEGIN SELECT RAISE(ABORT, 'conta administradora original nao pode ser excluida'); END;
