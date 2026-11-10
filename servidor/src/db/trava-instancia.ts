// Trava de instância única do servidor — banco SQLite dedicado.
//
// Por que SQLite e não lockfile+PID: os locks de banco são impostos pelo
// SO e liberados automaticamente quando o processo morre — sem PID file,
// sem problema de PID reutilizado e sem recuperação manual de trava
// abandonada. Funciona igual em Windows (LockFile) e Linux (fcntl).
//
// O servidor segura BEGIN EXCLUSIVE na trava pela vida do processo; o
// restaurador tenta BEGIN IMMEDIATE com busy_timeout=0 — SQLITE_BUSY
// prova instância ativa; qualquer outro erro é "indeterminado" e o
// restaurador aborta (fail-safe). Trava corrompida/ausente de forma
// inconsistente nunca autoriza a escrita.
import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

export function caminhoTrava(caminhoBanco: string): string {
  return caminhoBanco + ".trava";
}

let trava: Database.Database | null = null;

/**
 * Adquire a trava exclusiva do banco. Chamar ANTES de abrir a conexão
 * operacional (getDb). Lança erro claro se outra instância a detém.
 */
export function adquirirTravaInstancia(caminhoBanco: string): void {
  if (trava) return;
  const caminho = caminhoTrava(caminhoBanco);
  mkdirSync(dirname(caminho), { recursive: true });
  const db = new Database(caminho);
  db.pragma("busy_timeout = 0");
  try {
    db.exec("BEGIN EXCLUSIVE");
  } catch (e) {
    try { db.close(); } catch { /* ignora */ }
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`outra instância do Mestre RPG já está ativa neste banco (${msg})`);
  }
  trava = db;
}

/** Libera a trava (encerramento gracioso). Idempotente. */
export function liberarTravaInstancia(): void {
  try { trava?.exec("ROLLBACK"); } catch { /* já revertida/fechada */ }
  try { trava?.close(); } catch { /* ignora */ }
  trava = null;
}

export type EstadoTrava = "livre" | "em_uso" | "indeterminado";

/** Erro de aquisição da trava de restauração — nunca autoriza escrita. */
export class TravaIndisponivel extends Error {
  constructor(public estado: "em_uso" | "indeterminado", motivo: string) {
    super(motivo);
    this.name = "TravaIndisponivel";
  }
}

export interface TravaSegurada {
  /** Libera a trava (ROLLBACK + close). Idempotente. */
  liberar(): void;
}

/**
 * Ponto de sincronização determinístico para testes de concorrência:
 * quando MESTRE_TRAVA_GATE_DIR está definido, a trava fica PAUSADA após a
 * aquisição até que exista o arquivo <etapa> dentro do diretório. Sem a
 * variável, retorna imediatamente (produção inalterada).
 */
export function aguardarGateTrava(etapa: string): void {
  const dir = process.env.MESTRE_TRAVA_GATE_DIR;
  if (!dir) return;
  const alvo = join(dir, etapa);
  const sab = new Int32Array(new SharedArrayBuffer(4));
  const limite = Date.now() + 120_000;
  while (!existsSync(alvo)) {
    if (Date.now() > limite) throw new Error(`gate de trava '${etapa}' expirou (120s)`);
    Atomics.wait(sab, 0, 0, 50);
  }
}

function classificarFalhaTrava(e: unknown): TravaIndisponivel {
  const msg = e instanceof Error ? e.message : String(e);
  if (/SQLITE_BUSY|database is locked|database table is locked/i.test(msg)) {
    return new TravaIndisponivel("em_uso", `trava de instância detida — há um servidor Mestre RPG ativo neste banco (${msg})`);
  }
  return new TravaIndisponivel("indeterminado", `verificação da trava de instância inconclusiva (${msg})`);
}

/**
 * Adquire a MESMA trava exclusiva do servidor e a MANTÉM aberta.
 * Usada pelo restaurador: enquanto a transação estiver aberta, nenhuma
 * instância do servidor consegue iniciar neste banco (e vice-versa).
 * Lança TravaIndisponivel — o chamador aborta antes de qualquer escrita.
 */
export function adquirirTravaRestauracao(caminhoBanco: string): TravaSegurada {
  const caminho = caminhoTrava(caminhoBanco);
  mkdirSync(dirname(caminho), { recursive: true });
  const db = new Database(caminho);
  db.pragma("busy_timeout = 0");
  try {
    db.exec("BEGIN EXCLUSIVE");
  } catch (e) {
    try { db.close(); } catch { /* ignora */ }
    throw classificarFalhaTrava(e);
  }
  // Pausa determinística APÓS a aquisição — testes comprovam que um
  // segundo processo não consegue a trava enquanto esta está segurada.
  aguardarGateTrava("apos-trava");
  let liberada = false;
  return {
    liberar() {
      if (liberada) return;
      liberada = true;
      try { db.exec("ROLLBACK"); } catch { /* já revertida/fechada */ }
      try { db.close(); } catch { /* ignora */ }
    },
  };
}

/**
 * Verifica a trava SEM segurá-la: BEGIN IMMEDIATE com timeout zero.
 *  - "livre": trava ausente ou adquirida e liberada na hora;
 *  - "em_uso": SQLITE_BUSY — instância ativa detém BEGIN EXCLUSIVE;
 *  - "indeterminado": trava ilegível/corrompida/outro erro — fail-safe.
 */
export function verificarTravaInstancia(caminhoBanco: string): EstadoTrava {
  const caminho = caminhoTrava(caminhoBanco);
  if (!existsSync(caminho)) return "livre";
  let db: Database.Database | null = null;
  try {
    db = new Database(caminho);
    db.pragma("busy_timeout = 0");
    db.exec("BEGIN IMMEDIATE");
    db.exec("ROLLBACK");
    return "livre";
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/SQLITE_BUSY|database is locked|database table is locked/i.test(msg)) return "em_uso";
    return "indeterminado";
  } finally {
    try { db?.close(); } catch { /* ignora */ }
  }
}
