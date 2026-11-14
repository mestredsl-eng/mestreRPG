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
  // MESTRE_SQL_TRACE=1: loga cada statement preparado no stderr —
  // ferramenta de depuração e evidência de testes (ex.: provar ausência
  // de N+1). better-sqlite3 não tem evento de profile; prepare() é o
  // ponto onde todo SQL passa antes da execução.
  if (process.env.MESTRE_SQL_TRACE === "1") {
    const prepararOriginal = sqlite.prepare.bind(sqlite);
    sqlite.prepare = ((sql: string) => {
      console.error(`[sql] ${sql}`);
      return prepararOriginal(sql);
    }) as typeof sqlite.prepare;
  }
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

/**
 * Fecha a conexão SQLite compartilhada (encerramento gracioso).
 * A trava de instância só é liberada DEPOIS de o close() ser confirmado:
 * se o fechamento falhar, a exceção original é propagada e a trava
 * permanece presa — o processo deve encerrar (o SO libera tudo na morte),
 * nunca continuar servindo tráfego nem permitir que outra instância
 * assuma o banco com a conexão potencialmente aberta.
 * `fecharSqlite` é injetável apenas para teste do caminho de falha.
 */
export function fecharBanco(opcoes?: { fecharSqlite?: () => void }) {
  const fechar = opcoes?.fecharSqlite ?? (() => { sqliteInstancia?.close(); });
  if (!sqliteInstancia && !instancia) {
    // nada aberto — enceramento idempotente: só garante trava livre
    liberarTravaInstancia();
    return;
  }
  fechar(); // lança em caso de falha → trava NÃO é liberada
  sqliteInstancia = null;
  instancia = null;
  liberarTravaInstancia();
}
