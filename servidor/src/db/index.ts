import { drizzle } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import * as schema from "./schema.js";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const RAIZ = resolve(__dirname, "..", "..", "..");

export const CAMINHOS = {
  banco: resolve(RAIZ, "banco", "mestre-rpg.db"),
  arquivos: resolve(RAIZ, "arquivos", "campanhas"),
  backups: resolve(RAIZ, "backups"),
} as const;

export function criarBanco(caminho: string = CAMINHOS.banco) {
  mkdirSync(dirname(caminho), { recursive: true });
  const sqlite = new Database(caminho);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqliteInstancia = sqlite;
  return drizzle(sqlite, { schema });
}

export type Db = ReturnType<typeof criarBanco>;

let instancia: Db | null = null;
let sqliteInstancia: Database.Database | null = null;
/** Instância única do banco para toda a aplicação. */
export function getDb(): Db {
  if (!instancia) instancia = criarBanco(CAMINHOS.banco);
  return instancia;
}

/** Fecha a conexão SQLite compartilhada (encerramento gracioso). */
export function fecharBanco() {
  try { sqliteInstancia?.close(); } catch { }
  sqliteInstancia = null;
  instancia = null;
}
