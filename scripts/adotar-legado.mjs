#!/usr/bin/env node
// Adoção assistida e fail-closed de instalação legada 1.0.8 → 1.0.9.
//
// Ordem do Dono (#318, item 1): o launcher deve reconhecer SOMENTE o
// schema legado esperado, verificar integridade, criar e validar backup
// integral (DB + arquivos + configuração), registrar consentimento e
// persistir recibo de adoção idempotente.
//
//   node scripts/adotar-legado.mjs --confirmar-adocao
//
// Exit 0 = adotada agora ou já adotada (idempotente).
// Exit 1 = bloqueada — nada é gravado além de backups regeneráveis.
// Exit 2 = flag obrigatória ausente.
//
// Ordem crash-safe: TODAS as validações e o backup acontecem ANTES do
// único commit (gravarReciboInstalacao com dadosExtra.adocaoLegada).
// Um kill em qualquer ponto anterior deixa zero estado de protocolo —
// a próxima execução refaz a adoção do zero com segurança.
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import {
  copyFileSync, cpSync, existsSync, mkdirSync, readdirSync,
  readFileSync, statSync, writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  avaliarCandidatoAdocaoLegada,
  caminhoBancoConfigurado,
  gravarReciboInstalacao,
  instalacaoId,
  lerReciboInstalacao,
} from "./estado-externo.mjs";

const repoDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Schema legado esperado: main@7e17c9b (1.0.8) tem exatamente 34
// migrations no journal (última: 0033_release_1008). A candidata
// acrescenta 0034/0035 — banco legado adotado deve ter 34 linhas em
// __drizzle_migrations. Tabelas-sentinela do núcleo 1.0.8.
const MIGRATIONS_LEGADO_ESPERADAS = 34;
const TABELAS_SENTINELA = ["users", "campaigns", "server_settings", "__drizzle_migrations"];

function carregarBetterSqlite3() {
  const require = createRequire(import.meta.url);
  for (const base of [repoDir, process.cwd()]) {
    const pkg = join(base, "servidor", "package.json");
    if (existsSync(pkg)) {
      try { return require(require("node:path").join(base, "servidor", "node_modules", "better-sqlite3")); }
      catch { /* tenta o próximo candidato */ }
      try {
        const r2 = createRequire(pkg);
        return r2("better-sqlite3");
      } catch { /* tenta o próximo candidato */ }
    }
  }
  throw new Error("better-sqlite3 indisponível (servidor/node_modules ausente)");
}

function sha256Arquivo(caminho) {
  return createHash("sha256").update(readFileSync(caminho)).digest("hex");
}

function validarBancoLegado(dbPath) {
  const Database = carregarBetterSqlite3();
  const db = new Database(dbPath);
  try {
    const integridade = db.pragma("integrity_check", { simple: true });
    if (integridade !== "ok") return { ok: false, motivo: `integrity_check=${integridade}` };
    const fk = db.pragma("foreign_key_check");
    if (Array.isArray(fk) && fk.length) return { ok: false, motivo: `foreign_key_check=${fk.length} linhas` };
    const tabelas = new Set(
      db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name),
    );
    for (const t of TABELAS_SENTINELA) {
      if (!tabelas.has(t)) return { ok: false, motivo: `tabela-ausente:${t}` };
    }
    const migrations = db.prepare("SELECT count(*) AS n FROM __drizzle_migrations").get().n;
    if (migrations !== MIGRATIONS_LEGADO_ESPERADAS) {
      return { ok: false, motivo: `migrations=${migrations} (esperado ${MIGRATIONS_LEGADO_ESPERADAS})` };
    }
    return { ok: true, migrations };
  } finally {
    db.close();
  }
}

function checkpointWal(dbPath) {
  const Database = carregarBetterSqlite3();
  const db = new Database(dbPath);
  try { db.pragma("wal_checkpoint(TRUNCATE)"); }
  finally { db.close(); }
}

/** Backup integral: DB (pós-checkpoint) + sidecars + arquivos/campanhas
 *  + configuracao/. Manifesto com sha256+tamanho por arquivo; o hash do
 *  DB é re-verificado após a cópia (backup validado, não apenas copiado). */
function criarBackupIntegral(destino, dbPath) {
  mkdirSync(destino, { recursive: true });
  const manifesto = { criadoEm: new Date().toISOString(), arquivos: {} };
  const registrar = (origem, relativo) => {
    const alvo = join(destino, relativo);
    mkdirSync(dirname(alvo), { recursive: true });
    copyFileSync(origem, alvo);
    const hash = sha256Arquivo(alvo);
    if (hash !== sha256Arquivo(origem)) {
      throw new Error(`backup divergente: ${relativo}`);
    }
    manifesto.arquivos[relativo] = { size: statSync(alvo).size, sha256: hash };
  };
  registrar(dbPath, "banco/mestre-rpg.db");
  for (const sufixo of ["-wal", "-shm", "-journal"]) {
    const side = `${dbPath}${sufixo}`;
    if (existsSync(side)) registrar(side, `banco/mestre-rpg.db${sufixo}`);
  }
  const arquivos = (process.env.MESTRE_ARQUIVOS ?? "").trim()
    || join(repoDir, "arquivos", "campanhas");
  if (existsSync(arquivos)) {
    cpSync(arquivos, join(destino, "arquivos", "campanhas"), { recursive: true });
    const pilha = [arquivos];
    while (pilha.length) {
      const d = pilha.pop();
      for (const it of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, it.name);
        if (it.isDirectory()) pilha.push(p);
        else {
          const rel = `arquivos/campanhas/${p.slice(arquivos.length + 1).replace(/\\/g, "/")}`;
          manifesto.arquivos[rel] = { size: statSync(p).size, sha256: sha256Arquivo(p) };
        }
      }
    }
  }
  const configuracao = join(repoDir, "configuracao");
  if (existsSync(configuracao)) {
    cpSync(configuracao, join(destino, "configuracao"), { recursive: true });
    const pilha = [configuracao];
    while (pilha.length) {
      const d = pilha.pop();
      for (const it of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, it.name);
        if (it.isDirectory()) pilha.push(p);
        else {
          const rel = `configuracao/${p.slice(configuracao.length + 1).replace(/\\/g, "/")}`;
          manifesto.arquivos[rel] = { size: statSync(p).size, sha256: sha256Arquivo(p) };
        }
      }
    }
  }
  writeFileSync(join(destino, "manifesto.json"), JSON.stringify(manifesto, null, 2));
  return manifesto;
}

const bloqueio = (motivo) => {
  console.log(`[adocao] BLOQUEADO (${motivo}) — nenhuma alteração de estado foi gravada.`);
  process.exit(1);
};

if (!process.argv.slice(2).includes("--confirmar-adocao")) {
  console.log("uso: node scripts/adotar-legado.mjs --confirmar-adocao");
  console.log("A adoção de instalação legada exige confirmação explícita do operador.");
  process.exit(2);
}

// 1. Recibo de adoção já gravado ⇒ idempotente, nada a fazer.
const reciboAtual = lerReciboInstalacao(repoDir);
if (reciboAtual.status === "ok" && reciboAtual.dados?.adocaoLegada) {
  console.log("[adocao] instalação legada já adotada — recibo idempotente presente.");
  process.exit(0);
}
if (reciboAtual.status === "ok") {
  bloqueio("recibo-sem-adocao-legada");
}
if (reciboAtual.status !== "ausente") {
  bloqueio(`recibo-${reciboAtual.status}`);
}

// 2. Candidatura estrita: banco regular não-vazio, zero estado de
//    protocolo, state dir sem artefatos estranhos.
const candidato = avaliarCandidatoAdocaoLegada(repoDir);
if (!candidato.adotavel) bloqueio(candidato.motivo);

// 3. Schema + integridade do banco legado.
const dbPath = caminhoBancoConfigurado(repoDir);
checkpointWal(dbPath);
const validacao = validarBancoLegado(dbPath);
if (!validacao.ok) bloqueio(`banco-${validacao.motivo}`);

// 4. Backup integral validado (hash re-verificado na cópia).
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const baseBackups = (process.env.MESTRE_BACKUPS ?? "").trim() || join(repoDir, "backups");
const backupDir = join(baseBackups, `adocao-${stamp}`);
let manifesto;
try {
  manifesto = criarBackupIntegral(backupDir, dbPath);
} catch (e) {
  bloqueio(`backup-${String(e?.message ?? e).slice(0, 200)}`);
}

// 5. Commit único e atômico: recibo de instalação com evidência de
//    adoção. Consentimento registrado no próprio recibo (decisão do
//    operador via --confirmar-adocao + prompt S/N do launcher).
const recibo = gravarReciboInstalacao(repoDir, process.env, {
  adocaoLegada: {
    origem: "1.0.8",
    migrationsLegado: validacao.migrations,
    backupDir,
    backupManifestoSha256: createHash("sha256")
      .update(readFileSync(join(backupDir, "manifesto.json"))).digest("hex"),
    arquivosBackup: Object.keys(manifesto.arquivos).length,
    consentidoEm: new Date().toISOString(),
    instalacaoId: instalacaoId(repoDir),
  },
});
console.log(`[adocao] instalação legada adotada — recibo gravado (${backupDir}, ${Object.keys(manifesto.arquivos).length} arquivos em backup).`);
process.exit(0);
