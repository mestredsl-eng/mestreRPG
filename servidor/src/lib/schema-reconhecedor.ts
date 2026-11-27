// Reconhecedor de schema fail-closed — Issue #380.
//
// Contrato normativo: docs/ISSUE-380-ESPECIFICACAO-ADVERSARIAL-SCHEMA.md
// + Adendo A1 (P0-1/P0-2/P1-1..P1-5 incorporados). Função de diagnóstico:
// NUNCA grava arquivo, recibo, journal ou backup — somente leitura.
//
// Camadas (conjunção, fail-closed):
//   L1 journal↔arquivos: rows de __drizzle_migrations comparadas por
//      POSIÇÃO (rowid) contra entries[0..k) do _journal.json; hash
//      canônico = sha256(readFileSync(f).toString()) com conjunto de no
//      máximo 2 variantes por arquivo (worktree + CRLF-normalizado, P0-2);
//      `when` do journal estritamente crescente (P1-2);
//   L2 assinatura estrutural: REFERENCIA(k) por replay real das
//      migrations num SQLite :memory: — igualdade exata de
//      sqlite_master + table_xinfo por tabela;
//   L3 dados-sentinela: mapa por prefixo — hoje NAO-APLICAVEL em todos os
//      prefixos (P1-4): os únicos seeds data-only (novidades 1.0.x,
//      admin_principal) são editáveis/removíveis pela API admin ou
//      condicionais — sentinela fraca não conta. Quando uma migration
//      futura tiver efeito data-only imutável, registrar aqui com
//      justificativa;
//   L4 identidade: instalacaoIdBanco (server_settings) × recibo —
//      estrito somente quando há recibo válido desta instalação;
//      sem recibo válido o reconhecimento é "atribuida" (o vínculo é
//      decidido pelo fluxo de estado, não pela leitura de schema).
//
// integrity_check e foreign_key_check fazem parte da prova; falhas
// bloqueiam com detalhe acionável (P1-5/P2-3).
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
// servidor/src/lib → raiz do repo (mesma profundidade em src/ e dist/).
const RAIZ = resolve(__dirname, "..", "..", "..");
const CHAVE_ID_BANCO = "protocolo.instalacaoIdBanco";
const VERSAO_ALGORITMO_ASSINATURA = "ass-inv-1";

// ---------- tipos do contrato ----------
export type MotivoBloqueio =
  | "journal-ausente"
  | "journal-forjada"
  | "journal-extra"
  | "journal-interrompida"
  | "hash-divergente"
  | "estrutura-ausente"
  | "estrutura-divergente"
  | "sentinela-ausente"
  | "banco-nao-pertence-a-esta-instalacao"
  | "identidade-nao-atada"
  | "integridade-sqlite"
  | "chaves-estrangeiras"
  | "banco-ilegivel";

type Familia = "1.0.8" | "1.0.9" | "schema-39" | "atual" | `prefixo-${number}`;

export type ReconhecimentoSchema =
  | {
      ok: true;
      familia: Familia;
      migrations: number;
      assinaturaSchema?: string;
      evidencias: {
        journalExata: true;
        hashesValidos: true;
        estruturaValida: true;
        sentinelasDados: true;
        identidadeBanco: "confirmada" | "atribuida";
        integrityCheck: "ok";
        foreignKeyCheck: "ok";
      };
    }
  | { ok: false; motivo: MotivoBloqueio; detalhe?: string };

const falha = (motivo: MotivoBloqueio, detalhe?: string): ReconhecimentoSchema =>
  detalhe ? { ok: false, motivo, detalhe } : { ok: false, motivo };

// ---------- L1: journal + hashes ----------
interface EntradaJournal {
  idx: number;
  when: number;
  tag: string;
  breakpoints?: boolean;
}

function lerJournal(migrationsDir: string): { bruto: string; entries: EntradaJournal[] } {
  const caminho = join(migrationsDir, "meta", "_journal.json");
  const bruto = readFileSync(caminho, "utf8");
  const json = JSON.parse(bruto) as { entries?: EntradaJournal[] };
  if (!json || !Array.isArray(json.entries)) {
    throw new Error("journal sem entries[]");
  }
  return { bruto, entries: json.entries };
}

/** P0-1 literal: sha256 da STRING decodificada (readFileSync().toString()),
 *  nunca dos bytes crus. Devolve o conjunto determinístico de ≤2 variantes
 *  (P0-2): conteúdo como está no worktree + mesmo conteúdo normalizado CRLF. */
function hashesAceitosSql(caminho: string): Set<string> {
  const conteudo = readFileSync(caminho).toString();
  const variantes = new Set<string>([createHash("sha256").update(conteudo).digest("hex")]);
  const crlf = conteudo.replace(/\r\n/g, "\n").replace(/\n/g, "\r\n");
  if (crlf !== conteudo) variantes.add(createHash("sha256").update(crlf).digest("hex"));
  return variantes;
}

// ---------- L2: replay + assinatura estrutural ----------
interface ColunaInfo {
  name: string;
  type: string;
  notnull: number;
  dflt_value: unknown;
  pk: number;
  hidden: number;
}

interface ObjetoEstrutura {
  type: string;
  name: string;
  sql: string | null;
}

interface EstruturaCanonica {
  objetos: ObjetoEstrutura[];
  tabelas: Record<string, ColunaInfo[]>;
}

// P0-2 estendida à estrutura: sqlite_master.sql preserva o texto do
// statement como executado — CRLF×LF do checkout não pode divergir a
// assinatura (mesma dualidade aceita para o hash). Normalização EOL é
// canônica dos dois lados; conteúdo lógico divergente continua falhando.
const normEol = (s: string | null | undefined) => (s ?? "").replace(/\r\n/g, "\n");

function extrairEstrutura(db: Database.Database): EstruturaCanonica {
  const objetos = db
    .prepare(
      `SELECT type, name, sql FROM sqlite_master
        WHERE name NOT LIKE 'sqlite_%' AND name != '__drizzle_migrations'
        ORDER BY type, name`,
    )
    .all() as ObjetoEstrutura[];
  const tabelas: Record<string, ColunaInfo[]> = {};
  for (const o of objetos) {
    if (o.type !== "table") continue;
    // P2-1: table_xinfo cobre hidden/generated columns.
    const cols = db.prepare(`PRAGMA table_xinfo(${JSON.stringify(o.name)})`).all() as ColunaInfo[];
    tabelas[o.name] = cols.map((c) => ({
      name: c.name,
      type: c.type ?? "",
      notnull: c.notnull,
      dflt_value: typeof c.dflt_value === "string" ? normEol(c.dflt_value) : (c.dflt_value ?? null),
      pk: c.pk,
      hidden: c.hidden ?? 0,
    }));
  }
  return {
    objetos: objetos.map((o) => ({ ...o, sql: o.sql == null ? null : normEol(o.sql) })),
    tabelas,
  };
}

function canonicoJson(e: EstruturaCanonica): string {
  const tabelas: Record<string, unknown> = {};
  for (const nome of Object.keys(e.tabelas).sort()) tabelas[nome] = e.tabelas[nome];
  return JSON.stringify({ objetos: e.objetos, tabelas });
}

function hashEstrutura(e: EstruturaCanonica): string {
  return createHash("sha256").update(canonicoJson(e)).digest("hex");
}

/** Executa o conteúdo de um .sql como o migrator faz: split por
 *  `--> statement-breakpoint` quando entry.breakpoints !== false. */
function aplicarSql(db: Database.Database, sql: string, breakpoints: boolean | undefined) {
  const partes = breakpoints === false ? [sql] : sql.split("--> statement-breakpoint");
  for (const p of partes) {
    const stmt = p.trim();
    if (stmt) db.exec(stmt);
  }
}

interface Referencia {
  hash: string;
  estrutura: EstruturaCanonica;
}

const cacheReferencia = new Map<string, Referencia>();

/** REFERENCIA(k): replay real das entries[0..k) num :memory: com o mesmo
 *  formato de execução do migrator Drizzle. Cache por (journal+sql+versão). */
function referenciaPrefixo(migrationsDir: string, k: number, entries: EntradaJournal[], brutoJournal: string): Referencia {
  const hashes = entries.slice(0, k).map((e) => {
    const arq = join(migrationsDir, `${e.tag}.sql`);
    return existsSync(arq) ? hashArquivoTexto(arq) : `AUSENTE:${e.tag}`;
  });
  const chaveCache = createHash("sha256")
    .update(`${VERSAO_ALGORITMO_ASSINATURA}|${k}|${createHash("sha256").update(brutoJournal).digest("hex")}|${hashes.join(",")}`)
    .digest("hex");
  const hit = cacheReferencia.get(chaveCache);
  if (hit) return hit;

  const memoria = new Database(":memory:");
  try {
    for (let i = 0; i < k; i++) {
      const e = entries[i];
      const arq = join(migrationsDir, `${e.tag}.sql`);
      aplicarSql(memoria, readFileSync(arq).toString(), e.breakpoints);
    }
    const estrutura = extrairEstrutura(memoria);
    const ref: Referencia = { hash: hashEstrutura(estrutura), estrutura };
    cacheReferencia.set(chaveCache, ref);
    return ref;
  } finally {
    memoria.close();
  }
}

function hashArquivoTexto(caminho: string): string {
  return createHash("sha256").update(readFileSync(caminho).toString()).digest("hex");
}

// ---------- L3: sentinelas por prefixo (P1-4) ----------
// Mapa intencionalmente vazio: nenhum seed data-only atual é imutável
// (novidades é editável/removível via /api/admin/novidades; admin_principal
// é condicional). sentinelasDados = true é vacuoso até existir sentinela
// justificada — declarado, nunca satisfeita por sentinela fraca.
const SENTINELAS_POR_PREFIXO: Record<number, { descricao: string; sql: string; justificativa: string }[]> = {};

function checarSentinelas(db: Database.Database, k: number): { ok: boolean; faltantes: string[] } {
  const lista = SENTINELAS_POR_PREFIXO[k] ?? [];
  const faltantes: string[] = [];
  for (const s of lista) {
    const row = db.prepare(s.sql).get() as Record<string, unknown> | undefined;
    if (!row) faltantes.push(s.descricao);
  }
  return { ok: faltantes.length === 0, faltantes };
}

// ---------- L2: diff acionável ----------
function diffEstruturas(ref: EstruturaCanonica, cand: EstruturaCanonica): string {
  const partes: string[] = [];
  const chave = (o: ObjetoEstrutura) => `${o.type}:${o.name}`;
  const refMap = new Map(ref.objetos.map((o) => [chave(o), o]));
  const candMap = new Map(cand.objetos.map((o) => [chave(o), o]));
  const faltantes = ref.objetos.filter((o) => !candMap.has(chave(o))).map((o) => `${o.type} ${o.name}`);
  const extras = cand.objetos.filter((o) => !refMap.has(chave(o))).map((o) => `${o.type} ${o.name}`);
  const divergentes = ref.objetos
    .filter((o) => candMap.has(chave(o)) && (candMap.get(chave(o))!.sql ?? "") !== (o.sql ?? ""))
    .map((o) => `${o.type} ${o.name}`);
  for (const t of Object.keys(ref.tabelas)) {
    const rc = ref.tabelas[t];
    const cc = cand.tabelas[t];
    if (!cc) continue; // já reportado como faltante
    const rCols = new Map(rc.map((c) => [c.name, c]));
    const cCols = new Map(cc.map((c) => [c.name, c]));
    const colsFaltantes = rc.filter((c) => !cCols.has(c.name)).map((c) => c.name);
    const colsExtras = cc.filter((c) => !rCols.has(c.name)).map((c) => c.name);
    const colsDiff = rc
      .filter((c) => cCols.has(c.name) && JSON.stringify(c) !== JSON.stringify(cCols.get(c.name)))
      .map((c) => c.name);
    if (colsFaltantes.length || colsExtras.length || colsDiff.length) {
      partes.push(
        `tabela ${t}: colunas faltantes=[${colsFaltantes.join(",")}] ` +
        `extras=[${colsExtras.join(",")}] divergentes=[${colsDiff.join(",")}]`,
      );
    }
  }
  const cab = [
    faltantes.length ? `objetos faltantes: ${faltantes.join("; ")}` : "",
    extras.length ? `objetos extras: ${extras.join("; ")}` : "",
    divergentes.length ? `definições divergentes: ${divergentes.join("; ")}` : "",
  ].filter(Boolean);
  if (cab.length) partes.unshift(cab.join(" | "));
  return partes.join(" || ") || "assinatura estrutural divergente sem detalhe";
}

// ---------- L4: identidade do banco ----------
interface LeituraEstadoMod {
  lerReciboInstalacao(repoDir: string, env?: NodeJS.ProcessEnv): { status: string; dados?: Record<string, unknown> };
  lerIntencaoVinculacao?(repoDir: string, env?: NodeJS.ProcessEnv): { status: string; dados?: Record<string, unknown> };
}

async function lerEstadoExterno(): Promise<LeituraEstadoMod | null> {
  try {
    const href = new URL("../../../scripts/estado-externo.mjs", import.meta.url).href;
    return (await import(href)) as LeituraEstadoMod;
  } catch {
    return null;
  }
}

function lerIdBanco(db: Database.Database): string | null {
  try {
    const tem = db
      .prepare("select name from sqlite_master where type='table' and name='server_settings'")
      .get();
    if (!tem) return null;
    const row = db
      .prepare("select value from server_settings where key=?")
      .get(CHAVE_ID_BANCO) as { value?: unknown } | undefined;
    if (!row?.value) return null;
    let valor: unknown = row.value;
    if (typeof valor === "string") {
      try { valor = JSON.parse(valor); } catch { /* string crua */ }
    }
    if (valor && typeof valor === "object" && typeof (valor as { id?: unknown }).id === "string") {
      return (valor as { id: string }).id;
    }
    return typeof valor === "string" ? valor : null;
  } catch {
    return null;
  }
}

async function avaliarIdentidade(
  db: Database.Database,
  env: NodeJS.ProcessEnv,
): Promise<{ identidadeBanco: "confirmada" | "atribuida" } | { bloqueio: ReconhecimentoSchema }> {
  const mod = await lerEstadoExterno();
  if (!mod) return { identidadeBanco: "atribuida" }; // sem estado externo → sem prova; vínculo decide
  const recibo = mod.lerReciboInstalacao(RAIZ, env);
  const dbId = lerIdBanco(db);

  if (recibo.status !== "ok") {
    // Sem recibo válido desta instalação não há âncora para confrontar:
    // o reconhecimento fica "atribuida" — adoção/vínculo é decisão do
    // fluxo de estado (recibo ausente ⇒ reconhecer, não adotar sozinho).
    return { identidadeBanco: "atribuida" };
  }

  const recId = typeof recibo.dados?.instalacaoIdBanco === "string"
    ? (recibo.dados.instalacaoIdBanco as string)
    : null;

  if (dbId && recId) {
    return dbId === recId
      ? { identidadeBanco: "confirmada" }
      : { bloqueio: falha("banco-nao-pertence-a-esta-instalacao", `id do banco difere do recibo`) };
  }
  if (dbId && !recId) {
    // B6: id no banco sem id no recibo — só converge via intenção válida
    // (transição em curso); fora isso é órfão → bloqueio fail-closed.
    const intencao = mod.lerIntencaoVinculacao?.(RAIZ, env);
    const convergido = intencao?.status === "ok"
      && (intencao.dados as { instalacaoIdBanco?: unknown })?.instalacaoIdBanco === dbId;
    return convergido
      ? { identidadeBanco: "confirmada" }
      : { bloqueio: falha("identidade-nao-atada", "banco tem instalacaoIdBanco mas o recibo não — sem intenção válida") };
  }
  if (!dbId && recId) {
    return { bloqueio: falha("banco-nao-pertence-a-esta-instalacao", "recibo exige instalacaoIdBanco ausente no banco") };
  }
  // Recibo legado sem id + banco sem id → verify-once pendente.
  return { identidadeBanco: "atribuida" };
}

// ---------- abertura somente-leitura ----------
let tmpFallback: string | null = null;

function abrirSomenteLeitura(dbPath: string): Database.Database {
  try {
    return new Database(dbPath, { readonly: true, fileMustExist: true });
  } catch (e) {
    // WAL sem -shm legível pode recusar readonly; fallback: cópia
    // descartável em tmp — o diagnóstico nunca toca o arquivo original.
    const dir = mkdtempSync(join(tmpdir(), "mestre-380-"));
    const copia = join(dir, "copia.db");
    try {
      copyFileSync(dbPath, copia);
      for (const suf of ["-wal", "-shm", "-journal"]) {
        if (existsSync(dbPath + suf)) copyFileSync(dbPath + suf, copia + suf);
      }
      tmpFallback = dir;
      return new Database(copia);
    } catch {
      rmSync(dir, { recursive: true, force: true });
      throw e;
    }
  }
}

// ---------- reconhecedor ----------
export async function reconhecerSchema(
  dbPath: string,
  migrationsDir: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ReconhecimentoSchema> {
  const mig = resolve(migrationsDir);
  if (!existsSync(dbPath)) return falha("banco-ilegivel", "arquivo de banco ausente");

  let db: Database.Database;
  try {
    db = abrirSomenteLeitura(dbPath);
  } catch (e) {
    return falha("banco-ilegivel", String((e as Error)?.message ?? e).slice(0, 200));
  }

  try {
    // Integridade primeiro: banco corrompido não sustenta as demais provas.
    const integ = db.pragma("integrity_check", { simple: true });
    if (integ !== "ok") return falha("integridade-sqlite", String(integ).slice(0, 300));

    const fkRows = db.pragma("foreign_key_check") as Record<string, unknown>[];
    if (Array.isArray(fkRows) && fkRows.length > 0) {
      const amostra = fkRows.slice(0, 10)
        .map((r) => `${r.table ?? "?"}.${r.rowid ?? "?"}:${r.parent ?? "?"}`)
        .join("; ");
      return falha("chaves-estrangeiras", `${fkRows.length} violação(ões) — ${amostra}`);
    }

    // ---- L1 ----
    let journal: { bruto: string; entries: EntradaJournal[] };
    try {
      journal = lerJournal(mig);
    } catch (e) {
      return falha("journal-ausente", `journal ilegível: ${String((e as Error)?.message ?? e).slice(0, 160)}`);
    }
    const { entries } = journal;
    // P1-2: `when` estritamente crescente é invariante do projeto.
    for (let i = 1; i < entries.length; i++) {
      if (!(Number(entries[i].when) > Number(entries[i - 1].when))) {
        return falha("journal-forjada", `when não estritamente crescente em entries[${i}]`);
      }
    }
    // Toda entry precisa de .sql correspondente no worktree.
    for (const e of entries) {
      if (!existsSync(join(mig, `${e.tag}.sql`))) {
        return falha("journal-forjada", `entry ${e.tag} sem arquivo .sql correspondente`);
      }
    }

    const temTabela = db
      .prepare("select name from sqlite_master where type='table' and name='__drizzle_migrations'")
      .get();
    if (!temTabela) return falha("journal-ausente", "__drizzle_migrations ausente");
    const rows = db
      .prepare("select hash, created_at from __drizzle_migrations order by rowid")
      .all() as { hash: string; created_at: unknown }[];
    if (rows.length === 0) return falha("journal-ausente", "nenhuma migration registrada");
    if (rows.length > entries.length) return falha("journal-extra", `${rows.length} rows > ${entries.length} entries`);

    const k = rows.length;
    // P1-1: comparação POSICIONAL por rowid — nunca ORDER BY created_at.
    for (let i = 0; i < k; i++) {
      const row = rows[i];
      const entry = entries[i];
      const whenDb = Number(row.created_at);
      const whenEntry = Number(entry.when);
      if (whenDb !== whenEntry) {
        // Entrada pulada (row corresponde a uma entry futura) = interrupção;
        // demais divergências de ordem/valor = forja.
        const idxFuturo = entries.findIndex((e, j) => j !== i && Number(e.when) === whenDb);
        return falha(
          idxFuturo > i ? "journal-interrompida" : "journal-forjada",
          `rowid ${i}: created_at=${whenDb} ≠ when=${whenEntry} da entry ${entry.tag}`,
        );
      }
      const aceitos = hashesAceitosSql(join(mig, `${entry.tag}.sql`));
      if (!aceitos.has(String(row.hash))) {
        return falha("hash-divergente", `rowid ${i} (${entry.tag}): hash persistido não confere com nenhuma variante canônica`);
      }
    }

    // ---- L2 ----
    const ref = referenciaPrefixo(mig, k, entries, journal.bruto);
    const cand = extrairEstrutura(db);
    if (hashEstrutura(cand) !== ref.hash) {
      const faltantes = ref.estrutura.objetos.filter((o) => !cand.objetos.some((c) => c.type === o.type && c.name === o.name));
      const motivo = faltantes.length > 0 ? "estrutura-ausente" : "estrutura-divergente";
      return falha(motivo, diffEstruturas(ref.estrutura, cand));
    }

    // ---- L3 ----
    const sent = checarSentinelas(db, k);
    if (!sent.ok) return falha("sentinela-ausente", `sentinelas ausentes: ${sent.faltantes.join("; ")}`);

    // ---- L4 ----
    const l4 = await avaliarIdentidade(db, env);
    if ("bloqueio" in l4) return l4.bloqueio;

    const familia: Familia =
      k === entries.length ? "atual"
      : k === 34 ? "1.0.8"
      : k === 36 ? "1.0.9"
      : k === 39 ? "schema-39"
      : `prefixo-${k}`;

    return {
      ok: true,
      familia,
      migrations: k,
      assinaturaSchema: ref.hash,
      evidencias: {
        journalExata: true,
        hashesValidos: true,
        estruturaValida: true,
        sentinelasDados: true,
        identidadeBanco: l4.identidadeBanco,
        integrityCheck: "ok",
        foreignKeyCheck: "ok",
      },
    };
  } finally {
    try { db.close(); } catch { /* readonly */ }
    if (tmpFallback) {
      try { rmSync(tmpFallback, { recursive: true, force: true }); } catch { /* best effort */ }
      tmpFallback = null;
    }
  }
}

/** Assinatura de referência do prefixo corrente (k = total de entries) —
 *  usada pelo migrate para regravar `assinaturaSchema` no recibo (P1-3). */
export function assinaturaSchemaCorrente(migrationsDir: string): { hash: string; migrations: number } {
  const mig = resolve(migrationsDir);
  const { bruto, entries } = lerJournal(mig);
  const ref = referenciaPrefixo(mig, entries.length, entries, bruto);
  return { hash: ref.hash, migrations: entries.length };
}
