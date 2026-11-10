import { drizzle } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import * as schema from "./schema.js";
import { adquirirTravaInstancia, liberarTravaInstancia } from "./trava-instancia.js";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const RAIZ = resolve(__dirname, "..", "..", "..");

export const CAMINHOS = {
  banco: process.env.MESTRE_BANCO ? resolve(process.env.MESTRE_BANCO) : resolve(RAIZ, "banco", "mestre-rpg.db"),
  arquivos: process.env.MESTRE_ARQUIVOS ? resolve(process.env.MESTRE_ARQUIVOS) : resolve(RAIZ, "arquivos", "campanhas"),
  backups: process.env.MESTRE_BACKUPS ? resolve(process.env.MESTRE_BACKUPS) : resolve(RAIZ, "backups"),
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
  if (!instancia) {
    // Trava de instância ANTES da conexão operacional: se outra instância
    // já detém o banco, esta aborta aqui — antes de aceitar qualquer
    // tráfego. O lock é do SO e morre com o processo (sem PID file).
    adquirirTravaInstancia(CAMINHOS.banco);
    instancia = criarBanco(CAMINHOS.banco);
  }
  return instancia;
}

/** Fecha a conexão SQLite compartilhada (encerramento gracioso). */
export function fecharBanco() {
  liberarTravaInstancia();
  try { sqliteInstancia?.close(); } catch { }
  sqliteInstancia = null;
  instancia = null;
}
