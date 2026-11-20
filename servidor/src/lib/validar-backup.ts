// Validação integral de backup restaurável — Issue #155.
// Módulo NEUTRO: sem imports de db/index, logs ou estado externo —
// pode ser usado pelo servidor (backup.ts) e pelo restaurador
// OFFLINE (aplicar-restauracao.js), que não pode inicializar o banco
// nem adquirir locks.
//
// Regras (contrato):
//  - manifesto.json obrigatório, parseável, manifestoVersao === 2;
//  - inventário REAL do diretório comparado com o declarado, nos dois
//    sentidos: arquivo sem entrada no manifesto ⇒ rejeita; entrada sem
//    arquivo correspondente ⇒ rejeita;
//  - caminhos absolutos, traversal (".."), separadores inválidos e
//    symlinks ⇒ rejeita;
//  - tamanho + SHA-256 conferidos para banco, configuração e todos os
//    arquivos de campanha declarados;
//  - ausência intencional de configuração representada por
//    `configuracao: null` no manifesto (chave obrigatória);
//  - integridade SQLite (PRAGMA integrity_check) do banco snapshot.
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";

export interface ResultadoValidacaoBackup {
  ok: boolean;
  problemas: string[];
}

const TAM_MAX_ARQUIVO_HASH = 2 * 1024 * 1024 * 1024; // 2 GiB — acima disso nem tenta hash

function sha256Arquivo(caminho: string): string {
  return createHash("sha256").update(readFileSync(caminho)).digest("hex");
}

interface MetaItem { size?: unknown; sha256?: unknown }

/** Caminho relativo declarado no manifesto é seguro? Rejeita absolutos,
 *  traversal, unidades Windows, segmentos vazios/dot e backslash. */
function caminhoDeclaradoValido(rel: string): boolean {
  if (typeof rel !== "string" || rel.length === 0) return false;
  if (rel.includes("\\") || rel.includes("\0")) return false;
  if (/^[A-Za-z]:/.test(rel) || rel.startsWith("/") || rel.startsWith("//")) return false;
  const partes = rel.split("/");
  if (partes.some((p) => !p || p === "." || p === "..")) return false;
  return true;
}

/** Enumera o inventário real de arquivos do backup (rel posix). */
function inventarioReal(dir: string, problemas: string[]): string[] {
  const arquivos: string[] = [];
  const andar = (atual: string, relBase: string) => {
    let entradas;
    try {
      entradas = readdirSync(atual, { withFileTypes: true });
    } catch (e) {
      problemas.push(`não foi possível enumerar ${relBase || "."}: ${String(e)}`);
      return;
    }
    for (const e of entradas) {
      const rel = relBase ? `${relBase}/${e.name}` : e.name;
      const p = join(atual, e.name);
      if (e.isSymbolicLink()) {
        problemas.push(`symlink proibido no backup: ${rel}`);
        continue;
      }
      if (e.isDirectory()) { andar(p, rel); continue; }
      if (e.isFile()) { arquivos.push(rel); continue; }
      problemas.push(`entrada não regular no backup: ${rel}`);
    }
  };
  andar(dir, "");
  return arquivos.sort();
}

/**
 * Valida um diretório de backup de forma integral e obrigatória.
 * Retorna { ok, problemas } — ok===true somente com zero problemas.
 */
export function validarBackup(dir: string): ResultadoValidacaoBackup {
  const problemas: string[] = [];
  const manPath = join(dir, "manifesto.json");
  if (!existsSync(manPath)) return { ok: false, problemas: ["manifesto.json ausente"] };

  let man: Record<string, unknown>;
  try {
    man = JSON.parse(readFileSync(manPath, "utf-8"));
  } catch (e) {
    return { ok: false, problemas: [`manifesto.json ilegível: ${String(e)}`] };
  }
  if (!man || typeof man !== "object" || Array.isArray(man)) {
    return { ok: false, problemas: ["manifesto.json não é um objeto JSON"] };
  }
  if (man.manifestoVersao !== 2) {
    problemas.push(`manifestoVersao incompatível: ${(man as { manifestoVersao?: unknown }).manifestoVersao ?? "ausente"}`);
  }

  // ---- declarações do manifesto (com validação de caminho) ----
  const declarados = new Map<string, MetaItem>(); // rel → meta
  const metaBanco = man.banco as MetaItem | undefined;
  if (!metaBanco || typeof metaBanco !== "object") {
    problemas.push("manifesto: entrada 'banco' ausente/incompleta");
  } else {
    declarados.set("mestre-rpg.db", metaBanco);
  }

  // configuração: chave OBRIGATÓRIA; null = ausência intencional;
  // objeto = {size, sha256} obrigatório.
  if (!("configuracao" in man)) {
    problemas.push("manifesto: campo 'configuracao' ausente (use null para ausência intencional)");
  } else {
    const cfg = man.configuracao;
    if (cfg !== null) {
      if (!cfg || typeof cfg !== "object") {
        problemas.push("manifesto: 'configuracao' inválido (esperado objeto ou null)");
      } else {
        declarados.set("configuracao/servidor.json", cfg as MetaItem);
      }
    }
  }

  const arqDecl = man.arquivos;
  if (!arqDecl || typeof arqDecl !== "object" || Array.isArray(arqDecl)) {
    problemas.push("manifesto: campo 'arquivos' ausente/inválido");
  } else {
    for (const [rel, meta] of Object.entries(arqDecl as Record<string, MetaItem>)) {
      if (!caminhoDeclaradoValido(rel)) {
        problemas.push(`manifesto: caminho inválido em arquivos: '${rel}'`);
        continue;
      }
      if (!rel.startsWith("arquivos/")) {
        problemas.push(`manifesto: entrada de arquivo fora de 'arquivos/': '${rel}'`);
        continue;
      }
      declarados.set(rel, meta);
    }
  }

  // ---- inventário real × declarado (nos dois sentidos) ----
  const reais = new Set(inventarioReal(dir, problemas));
  const permitidos = new Set(["manifesto.json"]);
  for (const rel of declarados.keys()) permitidos.add(rel);

  for (const rel of reais) {
    if (!permitidos.has(rel)) problemas.push(`arquivo sem entrada no manifesto: ${rel}`);
  }
  for (const rel of declarados.keys()) {
    if (!reais.has(rel)) problemas.push(`entrada do manifesto sem arquivo: ${rel}`);
  }

  // ---- tamanho + sha256 dos declarados presentes ----
  for (const [rel, meta] of declarados) {
    if (!reais.has(rel)) continue; // já reportado acima
    const p = join(dir, ...rel.split("/"));
    if (typeof meta?.size !== "number" || typeof meta?.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(meta.sha256)) {
      problemas.push(`${rel}: metadados incompletos no manifesto`);
      continue;
    }
    const st = statSync(p);
    if (st.size !== meta.size) {
      problemas.push(`${rel}: tamanho diverge (${st.size} != ${meta.size})`);
      continue;
    }
    if (st.size <= TAM_MAX_ARQUIVO_HASH && sha256Arquivo(p) !== meta.sha256) {
      problemas.push(`${rel}: sha256 diverge`);
    }
  }

  // ---- integridade SQLite do snapshot ----
  const dbPath = join(dir, "mestre-rpg.db");
  if (reais.has("mestre-rpg.db")) {
    try {
      const chk = new Database(dbPath, { readonly: true });
      try {
        const integ = String(chk.pragma("integrity_check", { simple: true }));
        if (integ !== "ok") problemas.push(`banco: integrity_check falhou (${integ.slice(0, 120)})`);
      } finally {
        chk.close();
      }
    } catch (e) {
      problemas.push(`banco: não foi possível verificar integridade (${String(e).slice(0, 120)})`);
    }
  }

  return { ok: problemas.length === 0, problemas };
}
