import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { CAMINHOS, RAIZ } from "../db/index.js";

export type NivelLog = "erro" | "aviso" | "info" | "diagnostico";

const DIR_LOGS = resolve(RAIZ, "logs");
const ARQ_LOG = resolve(DIR_LOGS, "servidor.log");
const TAM_MAX = 5 * 1024 * 1024; // 5 MB por arquivo
const MAX_GERACOES = 3;

function rotacionar() {
  try {
    if (!existsSync(ARQ_LOG) || statSync(ARQ_LOG).size < TAM_MAX) return;
    for (let i = MAX_GERACOES - 1; i >= 1; i--) {
      const origem = i === 1 ? ARQ_LOG : `${ARQ_LOG}.${i - 1}`;
      const destino = `${ARQ_LOG}.${i}`;
      if (existsSync(origem)) renameSync(origem, destino);
    }
  } catch { /* rotação é best-effort */ }
}

/** Registro operacional — nunca incluir senhas, tokens ou conteúdo de mensagens. */
export function log(nivel: NivelLog, mensagem: string, detalhe?: unknown) {
  try {
    mkdirSync(DIR_LOGS, { recursive: true });
    rotacionar();
    const linha = JSON.stringify({
      ts: new Date().toISOString(), nivel, msg: mensagem,
      ...(detalhe !== undefined ? { detalhe: sanitizar(detalhe) } : {}),
    });
    appendFileSync(ARQ_LOG, linha + "\n");
  } catch { /* log nunca derruba o servidor */ }
  if (nivel === "erro") console.error(`[erro] ${mensagem}`);
  else if (nivel === "aviso") console.warn(`[aviso] ${mensagem}`);
}

function sanitizar(v: unknown): unknown {
  if (typeof v === "string") {
    return v.replace(/(senha|password|token|cookie|authorization)["'\s:=]+[^\s,"'}]+/gi, "$1=***");
  }
  if (Array.isArray(v)) return v.map(sanitizar);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      out[k] = /senha|password|token|cookie|secret/i.test(k) ? "***" : sanitizar(x);
    }
    return out;
  }
  return v;
}

/** Últimas N linhas de log (mais recentes primeiro). */
export function lerLogs(limite = 200): { ts: string; nivel: string; msg: string; detalhe?: unknown }[] {
  const arquivos = [ARQ_LOG, `${ARQ_LOG}.1`, `${ARQ_LOG}.2`].filter(existsSync);
  const linhas: string[] = [];
  for (const arq of arquivos) {
    const conteudo = readFileSync(arq, "utf-8");
    linhas.push(...conteudo.trim().split("\n").filter(Boolean));
  }
  return linhas.slice(-limite * 3).map((l) => { try { return JSON.parse(l); } catch { return { ts: "", nivel: "info", msg: l }; } })
    .slice(-limite).reverse();
}

export { DIR_LOGS };
