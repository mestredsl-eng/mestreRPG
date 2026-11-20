// Proteção de backups contra a retenção diária/semanal (Issue #155).
// Backups referenciados por journal ativo (atualizacao-ultima.json,
// restauracao-externa.json) ou por marcador explícito em
// <stateDir>/protecao/*.json NÃO podem ser removidos pela rotação
// enquanto a operação que os referencia não concluir.
// Módulo neutro: sem dependência de banco — pode ser usado pelo
// restaurador offline e pelo backup.ts.
//
// FAIL-CLOSED (auditoria): qualquer falha que impeça PROVAR que a
// varredura está completa retorna null — nunca interpreta erro como
// ausência de proteção. Isso inclui: falha de importação do estado
// externo, state dir ilegável, JSON corrompido, protocolo incompatível,
// identidade divergente e falha de enumeração.
//
// Ciclo de vida dos markers (state/protecao/*.json):
//   - proteção ativa enquanto houver journal ou flag dependente;
//   - journal "concluido" deixa de proteger (validação final feita);
//   - "rollback-concluido" MANTÉM proteção (a flag ainda exige recuperação);
//   - marker expira em `ate` (default 30 dias) — não pode permanecer
//     eternamente por ausência de integração com o updater;
//   - o updater (Etapa 4, PENDENTE) deve chamar
//     desprotegerBackupContraRetencao() ao concluir+validar; o
//     restaurador já o faz ao concluir a aplicação.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { RAIZ } from "../db/index.js";
import { log } from "./logs.js";

const PROTOCOLO_VERSAO = 1;
const VALIDADE_MARKER_HORAS = 24 * 30; // 30 dias — bound contra markers eternos

export function normDir(p: string): string {
  const r = resolve(p);
  return process.platform === "win32" ? r.toLowerCase() : r;
}

interface EeProt {
  dirEstado(repoDir: string, env?: NodeJS.ProcessEnv): string;
  instalacaoId(repoDir: string): string;
  caminhoCanonico(repoDir: string): string;
  gravarJsonAtomico(caminho: string, obj: unknown): void;
}
let eeProt: EeProt | null = null;
let eeFalhou = false;
async function estadoExternoProt(): Promise<EeProt | null> {
  if (eeProt) return eeProt;
  if (eeFalhou) return null;
  try {
    const mod = await import(pathToFileURL(join(RAIZ, "scripts", "estado-externo.mjs")).href);
    eeProt = mod as unknown as EeProt;
    return eeProt;
  } catch {
    eeFalhou = true;
    return null; // sem estado externo → não é possível provar nada
  }
}

function idMarker(dirBackup: string): string {
  return createHash("sha256").update(normDir(dirBackup)).digest("hex").slice(0, 16);
}

/** Um JSON é "nosso" (journal/marker do protocolo) quando carrega os
 *  campos do namespace #155. Arquivos estranhos (ex.: lock do boot)
 *  não são validados como journal — mas JSON ilegível em qualquer
 *  *.json do state dir bloqueia (falha de leitura ≠ ausência). */
function ehNosso(j: unknown): j is Record<string, unknown> {
  if (!j || typeof j !== "object" || Array.isArray(j)) return false;
  const o = j as Record<string, unknown>;
  return "fase" in o || "backupDir" in o || "preRestoreDir" in o ||
    ("motivo" in o && "backupDir" in o) || "ate" in o;
}

/** Valida campos de identidade/protocolo de um registro nosso.
 *  Retorna string de problema ou null. */
function problemaIdentidade(j: Record<string, unknown>, id: string, canon: string): string | null {
  if (j.protocoloVersao !== PROTOCOLO_VERSAO) return `protocoloVersao incompatível (${String(j.protocoloVersao)})`;
  if (typeof j.instalacaoId === "string" && j.instalacaoId !== id) return "instalacaoId divergente";
  if (typeof j.repoCanon === "string" && j.repoCanon !== canon) return "repoCanon divergente";
  return null;
}

interface Varredura {
  protegidos: Set<string>;
  /** null quando a varredura não pôde ser completada — fail-closed. */
  completo: boolean;
}

async function varrerProtecao(): Promise<Varredura | null> {
  const ee = await estadoExternoProt();
  if (!ee) return null;
  let dir: string;
  let id: string;
  let canon: string;
  try {
    dir = ee.dirEstado(RAIZ, process.env);
    id = ee.instalacaoId(RAIZ);
    canon = ee.caminhoCanonico(RAIZ);
  } catch {
    return null;
  }
  const protegidos = new Set<string>();
  const agora = Date.now();

  const coletarJson = (arquivo: string, ehMarker: boolean): boolean => {
    let j: unknown;
    try {
      j = JSON.parse(readFileSync(arquivo, "utf8"));
    } catch {
      return false; // JSON ilegível → varredura incompleta
    }
    if (ehMarker || ehNosso(j)) {
      const o = j as Record<string, unknown>;
      const prob = problemaIdentidade(o, id, canon);
      if (prob) return false;
      // marker expirado: remove e não protege (ciclo de vida limitado)
      if (ehMarker && typeof o.ate === "string" && Date.parse(o.ate) < agora) {
        try { rmSync(arquivo, { force: true }); } catch { /* best-effort */ }
        return true;
      }
      // journal concluído não protege mais; rollback-concluído mantém
      // (a flag de restauração continua pendente no banco restaurado).
      if (!ehMarker && (o.fase === "concluido" || o.fase === "concluido-com-flag")) return true;
      for (const k of ["backupDir", "preRestoreDir", "dir", "filePath"]) {
        const v = o[k];
        if (typeof v === "string" && v) protegidos.add(normDir(v));
      }
    }
    return true;
  };

  let nomes: string[];
  try {
    nomes = existsSync(dir) ? readdirSync(dir) : [];
  } catch {
    return null; // state dir existe mas é ilegível → não prova ausência
  }
  for (const f of nomes) {
    if (!f.endsWith(".json") || f.includes(".quarentena-")) continue;
    if (!coletarJson(join(dir, f), false)) return null;
  }

  const protDir = join(dir, "protecao");
  let markers: string[] = [];
  try {
    if (existsSync(protDir)) markers = readdirSync(protDir);
  } catch {
    return null;
  }
  for (const f of markers) {
    if (!f.endsWith(".json")) continue;
    if (!coletarJson(join(protDir, f), true)) return null;
  }

  return { protegidos, completo: true };
}

/** Diretórios de backup protegidos por journals/markers ativos.
 *  Retorna null quando a varredura falha — o chamador deve ABORTAR a
 *  retenção (fail-safe: nunca rotacionar sem prova de que nada está
 *  protegido). */
export async function dirsProtegidosBackup(): Promise<Set<string> | null> {
  const v = await varrerProtecao();
  return v ? v.protegidos : null;
}

/** O diretório está referenciado por algum JOURNAL do state dir
 *  (não por marker)? Retorna null quando a verificação é inconclusiva
 *  — o chamador NÃO deve remover proteção nesse caso. */
export async function referenciadoPorJournal(dirBackup: string): Promise<boolean | null> {
  const ee = await estadoExternoProt();
  if (!ee) return null;
  let dir: string;
  try { dir = ee.dirEstado(RAIZ, process.env); } catch { return null; }
  let nomes: string[];
  try { nomes = existsSync(dir) ? readdirSync(dir) : []; } catch { return null; }
  const alvo = normDir(dirBackup);
  for (const f of nomes) {
    if (!f.endsWith(".json") || f.includes(".quarentena-")) continue;
    const arquivo = join(dir, f);
    let j: unknown;
    try { j = JSON.parse(readFileSync(arquivo, "utf8")); } catch { return null; }
    if (!ehNosso(j)) continue;
    const o = j as Record<string, unknown>;
    if (o.fase === "concluido" || o.fase === "concluido-com-flag") continue;
    for (const k of ["backupDir", "preRestoreDir", "dir", "filePath"]) {
      const v2 = o[k];
      if (typeof v2 === "string" && v2 && normDir(v2) === alvo) return true;
    }
  }
  return false;
}

/** Marca um diretório de backup como protegido contra retenção.
 *  Marker inclui validade (`ate`) — proteção não é eterna.
 *  opts.horasValidade: default 30 dias. Retorna false se não foi
 *  possível gravar. */
export async function protegerBackupContraRetencao(
  dirBackup: string, motivo: string,
  opts: { horasValidade?: number } = {},
): Promise<boolean> {
  const ee = await estadoExternoProt();
  if (!ee) return false;
  try {
    const dir = ee.dirEstado(RAIZ, process.env);
    const protDir = join(dir, "protecao");
    mkdirSync(protDir, { recursive: true });
    const horas = opts.horasValidade ?? VALIDADE_MARKER_HORAS;
    const criadoEm = new Date();
    ee.gravarJsonAtomico(join(protDir, `${idMarker(dirBackup)}.json`), {
      protocoloVersao: PROTOCOLO_VERSAO,
      instalacaoId: ee.instalacaoId(RAIZ),
      repoCanon: ee.caminhoCanonico(RAIZ),
      backupDir: dirBackup,
      motivo,
      criadoEm: criadoEm.toISOString(),
      ate: new Date(criadoEm.getTime() + horas * 3600_000).toISOString(),
    });
    return true;
  } catch {
    return false;
  }
}

/** Remove a proteção de um diretório (operação concluída e validada).
 *  O chamador é responsável por não remover proteção ainda necessária —
 *  use referenciadoPorJournal() antes quando houver dúvida. */
export async function desprotegerBackupContraRetencao(dirBackup: string): Promise<void> {
  const ee = await estadoExternoProt();
  if (!ee) return;
  try {
    const dir = ee.dirEstado(RAIZ, process.env);
    rmSync(join(dir, "protecao", `${idMarker(dirBackup)}.json`), { force: true });
  } catch (e) {
    log("erro", "falha ao remover proteção de backup", { dir: dirBackup, erro: String(e) });
  }
}
