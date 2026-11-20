// Proteção de backups contra a retenção diária/semanal (Issue #155).
// Backups referenciados por journal ativo (atualizacao-ultima.json,
// restauracao-externa.json) ou por marcador explícito em
// <stateDir>/protecao/*.json NÃO podem ser removidos pela rotação
// enquanto a operação que os referencia não concluir.
// Módulo neutro: sem dependência de banco — pode ser usado pelo
// restaurador offline e pelo backup.ts.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { RAIZ } from "../db/index.js";
import { log } from "./logs.js";

export function normDir(p: string): string {
  const r = resolve(p);
  return process.platform === "win32" ? r.toLowerCase() : r;
}

interface EeProt {
  dirEstado(repoDir: string, env?: NodeJS.ProcessEnv): string;
  instalacaoId(repoDir: string): string;
  gravarJsonAtomico(caminho: string, obj: unknown): void;
}
let eeProt: EeProt | null = null;
async function estadoExternoProt(): Promise<EeProt | null> {
  if (eeProt) return eeProt;
  try {
    const mod = await import(pathToFileURL(join(RAIZ, "scripts", "estado-externo.mjs")).href);
    eeProt = mod as unknown as EeProt;
    return eeProt;
  } catch {
    return null;
  }
}

function idMarker(dirBackup: string): string {
  return createHash("sha256").update(normDir(dirBackup)).digest("hex").slice(0, 16);
}

/** Diretórios de backup protegidos por journals/markers ativos.
 *  Retorna null quando a varredura falha — o chamador deve ABORTAR a
 *  retenção (fail-safe: nunca rotacionar sem prova de que nada está protegido). */
export async function dirsProtegidosBackup(): Promise<Set<string> | null> {
  const ee = await estadoExternoProt();
  if (!ee) return new Set(); // sem estado externo → nada protegido
  let dir: string;
  try { dir = ee.dirEstado(RAIZ, process.env); } catch { return null; }
  const protegidos = new Set<string>();
  const coletar = (arquivo: string) => {
    try {
      const j = JSON.parse(readFileSync(arquivo, "utf8"));
      // journal concluído não protege mais — a operação terminou e
      // validou; rollback-concluído MANTÉM proteção (a flag de
      // restauração continua pendente no banco restaurado).
      if (j?.fase === "concluido" || j?.fase === "concluido-com-flag") return;
      for (const k of ["backupDir", "preRestoreDir", "dir", "filePath"]) {
        const v = j?.[k];
        if (typeof v === "string" && v) protegidos.add(normDir(v));
      }
    } catch { /* journal corrompido bloqueia boot antes; aqui ignorado */ }
  };
  try {
    for (const f of readdirSync(dir)) {
      if (f.endsWith(".json") && !f.includes(".quarentena-")) coletar(join(dir, f));
    }
    const prot = join(dir, "protecao");
    if (existsSync(prot)) {
      for (const f of readdirSync(prot)) {
        if (f.endsWith(".json")) coletar(join(prot, f));
      }
    }
  } catch {
    return null; // state dir ilegível → não prova ausência de proteção
  }
  return protegidos;
}

/** Marca um diretório de backup como protegido contra retenção.
 *  Retorna false se não foi possível gravar. */
export async function protegerBackupContraRetencao(dirBackup: string, motivo: string): Promise<boolean> {
  const ee = await estadoExternoProt();
  if (!ee) return false;
  try {
    const dir = ee.dirEstado(RAIZ, process.env);
    const protDir = join(dir, "protecao");
    mkdirSync(protDir, { recursive: true });
    ee.gravarJsonAtomico(join(protDir, `${idMarker(dirBackup)}.json`), {
      backupDir: dirBackup, motivo, criadoEm: new Date().toISOString(),
      instalacaoId: ee.instalacaoId(RAIZ),
    });
    return true;
  } catch {
    return false;
  }
}

/** Remove a proteção de um diretório (operação concluída e validada). */
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
