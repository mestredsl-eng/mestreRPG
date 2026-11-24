#!/usr/bin/env node
// Adoção assistida de instalação legada (1.0.8 → 1.0.9) — Issue #274.
//
// Uma instalação 1.0.8 não possui NENHUM artefato do protocolo de estado
// externo (state dir, recibo, autorização, journals): para o gate de boot
// ela é "desconhecido" e o banco existente bloquearia o primeiro bootstrap.
// Este script é o produtor confiável que legitima essa instalação APÓS
// consentimento explícito do operador (o .bat pergunta S/N e só chama com
// --confirmar). Sem a flag, apenas diagnostica — nada é escrito.
//
// Provas exigidas antes de gravar o recibo permanente (todas fail-closed):
//   1. avaliarCandidatoAdocaoLegada: banco regular não-vazio, nenhum
//      artefato de protocolo pré-existente, state dir sem quarentenas
//      nem arquivos desconhecidos (apenas boot-lock e o próprio journal
//      de adoção são tolerados);
//   2. SQLite íntegro: PRAGMA integrity_check = ok e
//      foreign_key_check sem linhas;
//   3. schema reconhecido: __drizzle_migrations contém EXATAMENTE o
//      conjunto de migrations da 1.0.8 (idx 0..33 do journal) ou o
//      conjunto completo da candidata (já migrada por um boot
//      intermediário desta versão). Qualquer outro conjunto = esquema
//      desconhecido → bloqueio, nada é gravado;
//   4. backup completo VALIDADO: banco (+sidecars), configuracao/ e
//      arquivos/ copiados para backups/pre_adocao_<ts>/ com manifest
//      sha256; a cópia do banco é reaberta e passa por integrity_check;
//   5. journal durável adocao-legado.json registra a fase "backup-ok" —
//      interrupção é retomada sem repetir etapas concluídas.
//
// O recibo gravado é o MESMO instalacao-recibo.json do protocolo:
// a partir daí diagnosticarBootstrap retorna "instalacao-concluida" e o
// boot segue o fluxo normal (auto-update → builds → migrate → start).
//
// Exit 0 = adoção concluída (ou já concluída — idempotente).
// Exit 1 = bloqueada — nenhum recibo emitido.
// Exit 2 = uso incorreto — flag --confirmar ausente.
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import {
  cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  avaliarCandidatoAdocaoLegada, caminhoBancoConfigurado,
  gravarEstado, gravarJsonAtomico, gravarReciboInstalacao, lerJournal,
  lerReciboInstalacao,
} from "./estado-externo.mjs";

const repoDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const env = process.env;
const JOURNAL_ADOCAO = "adocao-legado.json";
// Último idx de migration presente na 1.0.8 (main@7e17c9b: 34 entradas,
// idx 0..33). A candidata adiciona 0034/0035 (idx 34/35).
const ULTIMO_IDX_108 = 33;

if (!process.argv.slice(2).includes("--confirmar")) {
  console.log("uso: node scripts/adotar-legado.mjs --confirmar");
  console.log("A adoção de instalação legada exige confirmação explícita do operador.");
  process.exit(2);
}

function falhar(motivo, detalhe = "") {
  console.error(`[adocao] BLOQUEADO (${motivo})${detalhe ? ` — ${detalhe}` : ""} — nenhum recibo emitido.`);
  process.exit(1);
}

// ---------- helpers ----------
function sha256Arquivo(caminho) {
  return createHash("sha256").update(readFileSync(caminho)).digest("hex");
}

function listarArquivos(base) {
  const saida = [];
  if (!existsSync(base)) return saida;
  const pilha = [base];
  while (pilha.length) {
    const dir = pilha.pop();
    for (const nome of readdirSync(dir)) {
      const p = join(dir, nome);
      const st = statSync(p);
      if (st.isDirectory()) pilha.push(p);
      else if (st.isFile()) saida.push(p);
    }
  }
  return saida.sort();
}

let _Database = null;
function requireSqlite() {
  if (_Database) return _Database;
  try {
    _Database = createRequire(import.meta.url)("better-sqlite3");
  } catch {
    falhar("sqlite-indisponivel", "better-sqlite3 não resolvido — execute 'npm ci' na raiz antes de adotar");
  }
  return _Database;
}

/** Revalida o backup no disco: arquivos presentes, tamanhos e hashes
 *  conferem com o manifesto, e o banco copiado passa em integrity_check. */
function validarBackup(backupDir, bancoCopiadoRel) {
  const manifestPath = join(backupDir, "manifest.json");
  if (!existsSync(manifestPath)) return { ok: false, motivo: "manifest-ausente" };
  let manifest;
  try { manifest = JSON.parse(readFileSync(manifestPath, "utf8")); }
  catch { return { ok: false, motivo: "manifest-corrompido" }; }
  if (!Array.isArray(manifest?.arquivos)) return { ok: false, motivo: "manifest-invalido" };
  for (const e of manifest.arquivos) {
    const destino = join(backupDir, e.destino ?? e.origem);
    if (!existsSync(destino)) return { ok: false, motivo: `backup-incompleto:${e.destino ?? e.origem}` };
    if (statSync(destino).size !== e.bytes) return { ok: false, motivo: `backup-divergente:${e.destino ?? e.origem}` };
    if (sha256Arquivo(destino) !== e.sha256) return { ok: false, motivo: `backup-adulterado:${e.destino ?? e.origem}` };
  }
  const bancoCopia = join(backupDir, bancoCopiadoRel);
  if (!existsSync(bancoCopia)) return { ok: false, motivo: "banco-copia-ausente" };
  try {
    const Database = requireSqlite();
    const db = new Database(bancoCopia, { fileMustExist: true });
    try {
      const integ = db.pragma("integrity_check", { simple: true });
      if (integ !== "ok") return { ok: false, motivo: "banco-copia-integridade" };
    } finally { db.close(); }
  } catch (e) {
    return { ok: false, motivo: `banco-copia-ilegivel:${e?.message ?? e}` };
  }
  return { ok: true };
}

// ---------- fluxo ----------

// 0. Idempotência: recibo já válido ⇒ adoção concluída.
const recibo = lerReciboInstalacao(repoDir, env);
if (recibo.status === "ok") {
  console.log("[adocao] instalação já adotada (recibo de instalação concluída presente).");
  process.exit(0);
}
if (recibo.status !== "ausente") {
  falhar(`recibo-${recibo.status}`);
}

const journal = lerJournal(repoDir, JOURNAL_ADOCAO, env);
if (["corrompido", "incompativel", "identidade-divergente"].includes(journal.status)) {
  falhar(`journal-adocao-${journal.status}`);
}
const faseJournal = journal.status === "ok" ? journal.dados?.fase : null;

// 1. Candidato legado — revalidado SEMPRE (defesa em profundidade; o
//    preflight do .bat já filtrou, mas este script pode ser chamado
//    diretamente). O journal de adoção é tolerado pelo avaliador.
const candidato = avaliarCandidatoAdocaoLegada(repoDir, env);
if (!candidato.adotavel) {
  falhar(candidato.motivo);
}

// 2. Validação do banco: integridade + esquema 1.0.8 exato ou 1.0.9 já
//    aplicada (quando um boot intermediário já migrou o banco oficial).
const banco = caminhoBancoConfigurado(repoDir, env);
let aplicadas;
try {
  const Database = requireSqlite();
  // Abertura read-write normal (não readonly): bancos em WAL mode
  // podem falhar em conexões estritamente readonly sem -shm/-wal.
  // Nenhum statement de escrita é executado; o Boot Lock garante que
  // nenhum servidor está usando o banco nesta etapa.
  const db = new Database(banco, { fileMustExist: true });
  try {
    const integ = db.pragma("integrity_check", { simple: true });
    if (integ !== "ok") falhar("integridade-sqlite", String(integ).slice(0, 200));
    const fk = db.pragma("foreign_key_check");
    if (Array.isArray(fk) && fk.length) falhar("chaves-estrangeiras", `${fk.length} violação(ões)`);
    aplicadas = db.prepare("SELECT created_at FROM __drizzle_migrations ORDER BY created_at")
      .all().map((r) => Number(r.created_at));
  } finally { db.close(); }
} catch (e) {
  if (String(e?.message ?? "").includes("[adocao]")) throw e;
  falhar("banco-ilegivel", e?.message ?? String(e));
}

const journalMigrations = JSON.parse(
  readFileSync(join(repoDir, "servidor", "migrations", "meta", "_journal.json"), "utf8"),
).entries.map((e) => Number(e.when)).sort((a, b) => a - b);
const conjuntoLegado = journalMigrations.filter((_, i) => i <= ULTIMO_IDX_108);
const conjuntoAtual = journalMigrations;
const mesmoConjunto = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const esquema = mesmoConjunto(aplicadas, conjuntoLegado) ? "1.0.8"
  : mesmoConjunto(aplicadas, conjuntoAtual) ? "1.0.9"
  : null;
if (!esquema) {
  falhar("esquema-nao-reconhecido",
    `aplicadas=${aplicadas.length} esperado=legado(${conjuntoLegado.length})|atual(${conjuntoAtual.length})`);
}
console.log(`[adocao] banco reconhecido: esquema ${esquema}, ${aplicadas.length} migrations aplicadas, integridade ok.`);

// 3. Backup validado — retomada reutiliza o backup atestado pelo journal
//    quando ele ainda confere no disco.
const dirBackups = (env.MESTRE_BACKUPS ?? "").trim() || join(repoDir, "backups");
let backupDir = faseJournal === "backup-ok" ? journal.dados?.backupDir : null;
let backupOk = false;
if (backupDir && existsSync(backupDir)) {
  const v = validarBackup(backupDir, join("banco", "mestre-rpg.db"));
  backupOk = v.ok;
  if (!v.ok) console.log(`[adocao] backup anterior inválido (${v.motivo}) — refazendo.`);
}
if (!backupOk) {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  backupDir = join(dirBackups, `pre_adocao_${ts}`);
  mkdirSync(backupDir, { recursive: true });

  // Banco + sidecars (WAL/SHM/journal) — byte a byte.
  const baseBanco = banco.split(/[\\/]/).pop();
  const dirBancoOrig = dirname(banco);
  const nomesBanco = [baseBanco];
  try {
    for (const n of readdirSync(dirBancoOrig)) {
      if (n.startsWith(baseBanco) && n !== baseBanco) nomesBanco.push(n);
    }
  } catch { /* dir do banco já foi validado como legível */ }
  const entradas = [];
  for (const n of nomesBanco) {
    const origem = join(dirBancoOrig, n);
    if (!existsSync(origem)) continue;
    const destino = join(backupDir, "banco", n);
    mkdirSync(dirname(destino), { recursive: true });
    cpSync(origem, destino);
    entradas.push({
      origem: `banco-orig/${n}`,
      destino: join("banco", n),
      bytes: statSync(origem).size,
      sha256: sha256Arquivo(origem),
    });
  }
  // configuracao/ e arquivos/ de dados do usuário.
  const dirConfig = join(repoDir, "configuracao");
  if (existsSync(dirConfig)) {
    for (const arquivo of listarArquivos(dirConfig)) {
      const rel = relative(dirConfig, arquivo);
      const destino = join(backupDir, "configuracao", rel);
      mkdirSync(dirname(destino), { recursive: true });
      cpSync(arquivo, destino);
      entradas.push({
        origem: join("configuracao", rel),
        destino: join("configuracao", rel),
        bytes: statSync(arquivo).size,
        sha256: sha256Arquivo(arquivo),
      });
    }
  }
  const dirArquivos = (env.MESTRE_ARQUIVOS ?? "").trim() || join(repoDir, "arquivos", "campanhas");
  if (existsSync(dirArquivos)) {
    for (const arquivo of listarArquivos(dirArquivos)) {
      const rel = relative(dirArquivos, arquivo);
      const destino = join(backupDir, "arquivos", rel);
      mkdirSync(dirname(destino), { recursive: true });
      cpSync(arquivo, destino);
      entradas.push({
        origem: join("arquivos", rel),
        destino: join("arquivos", rel),
        bytes: statSync(arquivo).size,
        sha256: sha256Arquivo(arquivo),
      });
    }
  }

  gravarJsonAtomico(join(backupDir, "manifest.json"), {
    tipo: "backup-pre-adocao",
    criadoEm: new Date().toISOString(),
    esquemaBanco: esquema,
    arquivos: entradas,
  });

  const v = validarBackup(backupDir, join("banco", "mestre-rpg.db"));
  if (!v.ok) falhar("backup-invalidado", v.motivo);
  gravarEstado(repoDir, JOURNAL_ADOCAO, {
    tipo: "adocao-legado",
    fase: "backup-ok",
    backupDir,
    esquema,
    migracoes: aplicadas.length,
  }, env);
  console.log(`[adocao] backup validado em ${backupDir} (${entradas.length} arquivo(s)).`);
}

// 4. Recibo permanente — só agora, com candidato + esquema + backup
//    comprovados. gravarReciboInstalacao é atômico.
gravarReciboInstalacao(repoDir, env, {
  origem: "adocao-legado",
  esquemaLegado: esquema,
  backupDir,
});
gravarEstado(repoDir, JOURNAL_ADOCAO, {
  tipo: "adocao-legado",
  fase: "concluida",
  backupDir,
  esquema,
  migracoes: aplicadas.length,
}, env);
console.log(`[adocao] CONCLUÍDA — instalação legada ${esquema} adotada. Backup em ${backupDir}.`);
process.exit(0);
