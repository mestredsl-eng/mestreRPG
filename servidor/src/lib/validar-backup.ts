// Validação integral de backup restaurável — Issue #155.
// Módulo NEUTRO: sem imports de db/index, logs ou estado externo —
// pode ser usado pelo servidor (backup.ts) e pelo restaurador
// OFFLINE (aplicar-restauracao.js), que não pode inicializar o banco
// nem adquirir locks.
//
// Regras (contrato):
//  - manifesto.json obrigatório, parseável;
//  - FORMATO v2 (atual): manifestoVersao === 2, entrada 'banco' e
//    'configuracao' obrigatórias, hashes de banco/config/arquivos;
//  - FORMATO LEGADO v1 (backups criados pela v1.0.8 e anteriores):
//    sem 'manifestoVersao', com 'arquivos' declarando size+sha256.
//    Suportado explicitamente — ver validarBackupLegado. Contrato
//    legado = o que a v1.0.8 verificava: integridade SQLite do banco +
//    tamanho/SHA-256 dos arquivos declarados + inventário sem
//    entradas não declaradas. Campos que o formato v1 não registrava
//    (hash do banco/config) NÃO são exigidos — não há como verificá-los;
//  - inventário REAL do diretório comparado com o declarado, nos dois
//    sentidos: arquivo sem entrada no manifesto ⇒ rejeita; entrada sem
//    arquivo correspondente ⇒ rejeita;
//  - caminhos absolutos, traversal (".."), separadores inválidos e
//    symlinks ⇒ rejeita;
//  - tamanho + SHA-256 conferidos para banco, configuração e todos os
//    arquivos de campanha declarados (v2); arquivos declarados (v1);
//  - ausência intencional de configuração representada por
//    `configuracao: null` no manifesto v2 (chave obrigatória);
//  - integridade SQLite (PRAGMA integrity_check) do banco snapshot.
import { createHash } from "node:crypto";
import { closeSync, existsSync, lstatSync, openSync, readSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";

export interface ResultadoValidacaoBackup {
  ok: boolean;
  problemas: string[];
}

const TAM_JANELA_HASH = 1024 * 1024; // 1 MiB por leitura

/** SHA-256 em streaming síncrono — memória limitada independentemente
 *  do tamanho do arquivo. NUNCA retornar ok sem verificar o hash
 *  declarado: não existe limite de tamanho que dispense a verificação. */
export function sha256Arquivo(caminho: string): string {
  const fd = openSync(caminho, "r");
  try {
    const h = createHash("sha256");
    const buf = Buffer.alloc(TAM_JANELA_HASH);
    let n = 0;
    while ((n = readSync(fd, buf, 0, buf.length, null)) > 0) {
      h.update(buf.subarray(0, n));
    }
    return h.digest("hex");
  } finally {
    closeSync(fd);
  }
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
  // Raiz do backup: deve ser diretório real — symlink ou não-diretório
  // é rejeitado antes de qualquer leitura (lstat não segue links).
  let stRoot;
  try {
    stRoot = lstatSync(dir);
  } catch (e) {
    return { ok: false, problemas: [`raiz do backup inacessível: ${String(e)}`] };
  }
  if (stRoot.isSymbolicLink()) return { ok: false, problemas: ["raiz do backup é symlink — proibido"] };
  if (!stRoot.isDirectory()) return { ok: false, problemas: ["raiz do backup não é um diretório"] };

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
  // Despacho por formato: v2 declara 'manifestoVersao'; o legado v1
  // (v1.0.8 e anteriores) não tem esse campo e é reconhecido pela
  // presença do mapa 'arquivos'. Qualquer outro formato é rejeitado.
  if (man.manifestoVersao === undefined) {
    return validarBackupLegado(dir, man);
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
    verificarMetaDeclarada(dir, rel, meta, problemas);
  }

  // ---- integridade SQLite do snapshot ----
  if (reais.has("mestre-rpg.db")) {
    verificarIntegridadeDb(join(dir, "mestre-rpg.db"), "banco", problemas);
  }

  return { ok: problemas.length === 0, problemas };
}

/** Confere size+sha256 de um arquivo declarado no manifesto. */
function verificarMetaDeclarada(dir: string, rel: string, meta: MetaItem, problemas: string[]): void {
  const p = join(dir, ...rel.split("/"));
  if (typeof meta?.size !== "number" || typeof meta?.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(meta.sha256)) {
    problemas.push(`${rel}: metadados incompletos no manifesto`);
    return;
  }
  // lstat: rejeita symlink trocado após o inventário (TOCTOU) e
  // qualquer entrada que não seja arquivo regular.
  let st;
  try {
    st = lstatSync(p);
  } catch (e) {
    problemas.push(`${rel}: arquivo declarado inacessível (${String(e).slice(0, 80)})`);
    return;
  }
  if (st.isSymbolicLink() || !st.isFile()) {
    problemas.push(`${rel}: não é arquivo regular (symlink/especial proibido)`);
    return;
  }
  if (st.size !== meta.size) {
    problemas.push(`${rel}: tamanho diverge (${st.size} != ${meta.size})`);
    return;
  }
  // Hash SEMPRE verificado em streaming — inclusive acima de 2 GiB.
  let hashReal: string;
  try {
    hashReal = sha256Arquivo(p);
  } catch (e) {
    problemas.push(`${rel}: falha ao calcular sha256 (${String(e).slice(0, 80)})`);
    return;
  }
  if (hashReal !== meta.sha256) {
    problemas.push(`${rel}: sha256 diverge`);
  }
}

/** PRAGMA integrity_check de um snapshot SQLite. */
function verificarIntegridadeDb(dbPath: string, rotulo: string, problemas: string[]): void {
  try {
    const chk = new Database(dbPath, { readonly: true });
    try {
      const integ = String(chk.pragma("integrity_check", { simple: true }));
      if (integ !== "ok") problemas.push(`${rotulo}: integrity_check falhou (${integ.slice(0, 120)})`);
    } finally {
      chk.close();
    }
  } catch (e) {
    problemas.push(`${rotulo}: não foi possível verificar integridade (${String(e).slice(0, 120)})`);
  }
}

/**
 * Valida backup no FORMATO LEGADO v1 — produzido pela v1.0.8 e
 * anteriores: { arquivos: { "arquivos/<rel>": {size,sha256} },
 * criadoEm, versao } — sem 'manifestoVersao', sem hashes de
 * banco/configuração (o formato não os registrava).
 *
 * Contrato = o que a v1.0.8 efetivamente verificava em
 * verificarBackup/prepararRestauracao: integridade SQLite do banco +
 * tamanho/SHA-256 de cada arquivo declarado + recusa de entradas não
 * declaradas no inventário. O restante do diretório é restrito ao que
 * o criador v1 escrevia: manifesto.json, mestre-rpg.db e, quando
 * presente, configuracao/servidor.json (não hasheado no v1 — mesmo
 * tratamento do verificador original).
 */
function validarBackupLegado(dir: string, man: Record<string, unknown>): ResultadoValidacaoBackup {
  const problemas: string[] = [];
  const arqDecl = man.arquivos;
  if (!arqDecl || typeof arqDecl !== "object" || Array.isArray(arqDecl)) {
    return { ok: false, problemas: ["manifesto.json não reconhecido: sem 'manifestoVersao' e sem mapa 'arquivos' válido (formato legado v1)"] };
  }

  // ---- banco: presença + integridade SQLite (contrato legado) ----
  const dbPath = join(dir, "mestre-rpg.db");
  if (!existsSync(dbPath)) {
    problemas.push("banco: mestre-rpg.db ausente");
  } else {
    verificarIntegridadeDb(dbPath, "banco", problemas);
  }

  // ---- arquivos declarados: caminho seguro + size/sha256 ----
  const declarados = new Set<string>();
  for (const [rel, meta] of Object.entries(arqDecl as Record<string, MetaItem>)) {
    if (!caminhoDeclaradoValido(rel) || !rel.startsWith("arquivos/")) {
      problemas.push(`manifesto legado: caminho inválido em arquivos: '${rel}'`);
      continue;
    }
    declarados.add(rel);
    verificarMetaDeclarada(dir, rel, meta, problemas);
  }

  // ---- inventário real restrito ao que o criador v1 escrevia ----
  const reais = new Set(inventarioReal(dir, problemas));
  const permitidos = new Set(["manifesto.json", "mestre-rpg.db", "configuracao/servidor.json", ...declarados]);
  for (const rel of reais) {
    if (!permitidos.has(rel)) problemas.push(`arquivo sem entrada no manifesto legado: ${rel}`);
  }
  for (const rel of declarados) {
    if (!reais.has(rel)) problemas.push(`entrada do manifesto sem arquivo: ${rel}`);
  }

  return { ok: problemas.length === 0, problemas };
}
