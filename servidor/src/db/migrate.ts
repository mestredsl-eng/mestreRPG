import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import Database from "better-sqlite3";
import { existsSync, statSync, readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { criarBanco, CAMINHOS } from "./index.js";
import { criarBackupPreUpdate } from "./backup-pre-update.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsFolder = resolve(__dirname, "..", "..", "migrations");

/**
 * P10-B: decide se o banco é LEGADO com migrations pendentes — único
 * caso que exige backup pré-migration. Instalação nova (arquivo
 * ausente/vazio/sem tabelas de usuário) e banco já em dia não geram
 * backup. Falha de leitura ⇒ true (fail-closed: prefere backup a
 * migrar sem rede de segurança).
 */
function precisaBackupPreMigration(caminho: string): boolean {
  try {
    if (!existsSync(caminho) || statSync(caminho).size === 0) return false;
    const journal = JSON.parse(readFileSync(join(migrationsFolder, "meta", "_journal.json"), "utf8"));
    const total = Array.isArray(journal?.entries) ? journal.entries.length : 0;
    const sqlite = new Database(caminho);
    try {
      const tabelas = sqlite.prepare("select name from sqlite_master where type='table'").all() as { name: string }[];
      const usuario = tabelas.filter((t) => !t.name.startsWith("sqlite_") && t.name !== "__drizzle_migrations");
      if (usuario.length === 0) return false;
      const temDrizzle = tabelas.some((t) => t.name === "__drizzle_migrations");
      const aplicadas = temDrizzle
        ? (sqlite.prepare("select count(*) as c from __drizzle_migrations").get() as { c: number }).c
        : 0;
      return total > aplicadas;
    } finally {
      sqlite.close();
    }
  } catch {
    return true;
  }
}

const precisaBackup = precisaBackupPreMigration(CAMINHOS.banco);
if (precisaBackup) {
  const r = await criarBackupPreUpdate({ fase: "pre-migration" }, "Backup pré-migration automático");
  const manifestoOk = r.sucesso === true && existsSync(join(r.dir, "manifesto.json"));
  if (!manifestoOk) {
    console.error(`[db] Backup pré-migration FALHOU (${(r.erros ?? []).join("; ") || "sem detalhe"}) — migrações NÃO aplicadas.`);
    process.exit(1);
  }
  console.log(`[db] Backup pré-migration criado e validado: ${r.dir}`);
}

const db = criarBanco(CAMINHOS.banco);
migrate(db, { migrationsFolder });
console.log(`[db] Migrações aplicadas em ${CAMINHOS.banco}`);
