#!/usr/bin/env node
// Testes — journal externo de restauração (Issue #155, contrato).
// W14: fail-closed — nenhum erro de leitura retorna sucesso silencioso.
// W15: retomada após interrupção na aplicação e no rollback, com
// checkpoints por componente (banco, sidecars, arquivos, config, flag).
// Estado simulado injetando restauracao-externa.json como ficaria após
// uma queda real; o restaurador deve completar apenas o pendente.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, rmSync, readdirSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { dirTeste, abrirDb } from "./teste-base.mjs";

const RAIZ_REPO = process.cwd();
const RESTAURADOR = join(RAIZ_REPO, "servidor/dist/db/aplicar-restauracao.js");
const { instalacaoId, dirEstado } = await import("./scripts/estado-externo.mjs");

let pass = 0, fail = 0;
const t = (n, c, extra = "") => { if (c) { pass++; console.log("  ok", n); } else { fail++; console.log("  FALHOU", n, extra); } };
const sec = (n) => console.log("\n== " + n + " ==");

const ID = instalacaoId(RAIZ_REPO);

function novoRaiz() {
  const raiz = dirTeste("restjrn");
  mkdirSync(join(raiz, "banco"), { recursive: true });
  mkdirSync(join(raiz, "arquivos", "campanhas"), { recursive: true });
  mkdirSync(join(raiz, "backups"), { recursive: true });
  mkdirSync(join(raiz, "configuracao"), { recursive: true });
  return raiz;
}
function envRaiz(raiz, extra = {}) {
  return {
    ...process.env,
    MESTRE_HOME: raiz,
    MESTRE_BANCO: join(raiz, "banco", "mestre-rpg.db"),
    MESTRE_ARQUIVOS: join(raiz, "arquivos", "campanhas"),
    MESTRE_BACKUPS: join(raiz, "backups"),
    MESTRE_STATE_DIR: join(raiz, "state"),
    ...extra,
  };
}
function rodar(raiz, env) {
  const r = spawnSync("node", [RESTAURADOR], { env: envRaiz(raiz, env), encoding: "utf8" });
  return { code: r.status, saida: (r.stdout ?? "") + (r.stderr ?? "") };
}
const dbVivo = (raiz) => join(raiz, "banco", "mestre-rpg.db");
const stateDir = (raiz) => join(raiz, "state", ID);
const journalPath = (raiz) => join(stateDir(raiz), "restauracao-externa.json");

function criarDbComSettings(raiz, { flag = null, comOutrasTabelas = true, tabelas = 0 } = {}) {
  const p = dbVivo(raiz);
  const db = abrirDb(p);
  db.exec("create table server_settings (key text primary key, value text, updated_at integer)");
  if (comOutrasTabelas || tabelas > 0) db.exec("create table outra (id integer)");
  for (let i = 1; i < tabelas; i++) db.exec(`create table t${i} (id integer)`);
  if (flag) db.prepare("insert into server_settings (key,value) values ('restauracao_pendente',?)").run(flag);
  db.close();
  return p;
}
function valorBanco(raiz) {
  try {
    const db = abrirDb(dbVivo(raiz));
    const r = db.prepare("select value from marcador").get();
    db.close();
    return r?.value ?? null;
  } catch { return "ILEGIVEL"; }
}
function criarBackupDir(raiz, marcador) {
  const dir = join(raiz, "backups", `bk_${marcador}`);
  mkdirSync(dir, { recursive: true });
  const db = abrirDb(join(dir, "mestre-rpg.db"));
  // schema mínimo realista: server_settings sempre existe em backups
  db.exec("create table server_settings (key text primary key, value text, updated_at integer)");
  db.exec("create table marcador (value text)");
  db.prepare("insert into marcador values (?)").run(marcador);
  db.close();
  mkdirSync(join(dir, "arquivos"), { recursive: true });
  writeFileSync(join(dir, "arquivos", "campanha.txt"), `conteudo-${marcador}`);
  mkdirSync(join(dir, "configuracao"), { recursive: true });
  writeFileSync(join(dir, "configuracao", "servidor.json"), `{"porta":${marcador === "novo" ? 4001 : 4000}}`);
  return dir;
}
/** Monta um lado/pre_restore_<ts> coerente com as flags tinha*. */
function criarLado(raiz, nome, { dbSrc, tinhaArquivos = true, tinhaCfg = true } = {}) {
  const lado = join(raiz, "backups", nome);
  mkdirSync(lado, { recursive: true });
  if (dbSrc) copyFileSync(dbSrc, join(lado, "mestre-rpg.db"));
  if (tinhaArquivos) {
    mkdirSync(join(lado, "arquivos"), { recursive: true });
    writeFileSync(join(lado, "arquivos", "velho.txt"), "estado-antigo");
  }
  if (tinhaCfg) {
    mkdirSync(join(lado, "configuracao"), { recursive: true });
    writeFileSync(join(lado, "configuracao", "servidor.json"), "{}");
  }
  return lado;
}
function componentes(estados) {
  const base = { banco: "pendente", sidecars: "pendente", arquivos: "pendente", configuracao: "pendente", flag: "pendente" };
  return { ...base, ...estados };
}
function gravarJournal(raiz, dados) {
  mkdirSync(stateDir(raiz), { recursive: true });
  writeFileSync(journalPath(raiz), JSON.stringify({
    protocoloVersao: 1, instalacaoId: ID, repoCanon: process.cwd().toLowerCase(),
    atualizadoEm: new Date().toISOString(), ...dados,
  }));
}
function lerJournal(raiz) {
  try { return JSON.parse(readFileSync(journalPath(raiz), "utf8")); } catch { return null; }
}

// ================= W14 — fail-closed =================
sec("W14 — nenhuma falha de leitura retorna sucesso silencioso");

{
  const raiz = novoRaiz();
  const r = rodar(raiz);
  t("banco inexistente → exit 0 (instalação inicial)", r.code === 0, `code=${r.code} ${r.saida.slice(0, 200)}`);
  rmSync(raiz, { recursive: true, force: true });
}
{
  const raiz = novoRaiz();
  // banco vazio (0 tabelas) = prova de inicial
  abrirDb(dbVivo(raiz)).close();
  const r = rodar(raiz);
  t("banco vazio (0 tabelas) → exit 0", r.code === 0, `code=${r.code}`);
  rmSync(raiz, { recursive: true, force: true });
}
{
  const raiz = novoRaiz();
  // banco existente COM tabelas mas SEM server_settings → estado desconhecido
  const db = abrirDb(dbVivo(raiz));
  db.exec("create table usuarios (id integer)");
  db.close();
  const r = rodar(raiz);
  t("banco sem server_settings → FAIL-CLOSED (exit != 0)", r.code !== 0, `code=${r.code}`);
  t("mensagem de estado desconhecido", /desconhecido|segurança/i.test(r.saida), r.saida.slice(0, 200));
  rmSync(raiz, { recursive: true, force: true });
}
{
  const raiz = novoRaiz();
  // banco corrompido: bytes aleatórios que o SQLite rejeita na consulta
  writeFileSync(dbVivo(raiz), Buffer.alloc(4096, 0xab));
  const r = rodar(raiz);
  t("banco corrompido → FAIL-CLOSED (exit != 0)", r.code !== 0, `code=${r.code}`);
  rmSync(raiz, { recursive: true, force: true });
}
{
  const raiz = novoRaiz();
  criarDbComSettings(raiz); // sem flag
  const r = rodar(raiz);
  t("banco válido sem flag → exit 0", r.code === 0, `code=${r.code} ${r.saida.slice(0, 150)}`);
  rmSync(raiz, { recursive: true, force: true });
}
{
  const raiz = novoRaiz();
  criarDbComSettings(raiz, { flag: "{ json invalido" });
  const r = rodar(raiz);
  t("flag ilegível → FAIL-CLOSED (exit != 0)", r.code !== 0, `code=${r.code}`);
  rmSync(raiz, { recursive: true, force: true });
}
{
  const raiz = novoRaiz();
  // journal corrompido → quarentena + bloqueio
  criarDbComSettings(raiz);
  mkdirSync(stateDir(raiz), { recursive: true });
  writeFileSync(journalPath(raiz), "{ quebrado");
  const r = rodar(raiz);
  t("journal corrompido → FAIL-CLOSED", r.code !== 0, `code=${r.code}`);
  t("journal foi para quarentena", readdirSync(stateDir(raiz)).some((f) => f.includes("quarentena")));
  rmSync(raiz, { recursive: true, force: true });
}

// ================= W15 — retomada aplicação =================
sec("W15a — retomada de aplicação interrompida no meio das substituições");
{
  const raiz = novoRaiz();
  const bk = criarBackupDir(raiz, "novo");
  // estado vivo: banco ANTIGO com flag; journal diz que preservação concluiu
  // e sidecars já foi feito, banco/arquivos/config/flag pendentes
  criarDbComSettings(raiz, { flag: JSON.stringify({ filePath: bk }) });
  // adiciona marcador no banco vivo para provar substituição
  const dv = abrirDb(dbVivo(raiz));
  dv.exec("create table marcador (value text)");
  dv.prepare("insert into marcador values ('velho')").run();
  dv.close();
  // lado preservado = estado antigo completo (coerente com tinha*)
  const lado = criarLado(raiz, "pre_restore_teste", { dbSrc: dbVivo(raiz) });
  gravarJournal(raiz, {
    fase: "substituicao-iniciada", backupDir: bk, preRestoreDir: lado,
    tinhaArquivos: true, tinhaCfg: false, // ARQ_CFG não existia antes
    componentes: componentes({ sidecars: "concluido" }),
  });
  const r = rodar(raiz);
  t("retomada de aplicação → exit 0", r.code === 0, `code=${r.code} ${r.saida.slice(0, 300)}`);
  t("banco vivo = conteúdo do backup", valorBanco(raiz) === "novo", `valor=${valorBanco(raiz)}`);
  t("flag removida do banco restaurado", !existsSync(dbVivo(raiz)) || !flagPresente(raiz));
  t("journal → concluido", lerJournal(raiz)?.fase === "concluido", lerJournal(raiz)?.fase);
  rmSync(raiz, { recursive: true, force: true });
}
function flagPresente(raiz) {
  try {
    const db = abrirDb(dbVivo(raiz));
    const row = db.prepare("select value from server_settings where key='restauracao_pendente'").get();
    db.close();
    return !!row;
  } catch { return false; }
}

sec("W15b — retomada de aplicação sem flag (banco já substituído)");
{
  const raiz = novoRaiz();
  const bk = criarBackupDir(raiz, "novo2");
  // banco vivo JÁ é o do backup (substituição ocorreu), flag sumiu —
  // journal é a única fonte de verdade
  copyFileSync(join(bk, "mestre-rpg.db"), dbVivo(raiz));
  const lado = criarLado(raiz, "pre_restore_teste2");
  const dbVelho = abrirDb(join(lado, "mestre-rpg.db"));
  dbVelho.exec("create table marcador (value text)");
  dbVelho.prepare("insert into marcador values ('velho')").run();
  dbVelho.close();
  gravarJournal(raiz, {
    fase: "substituicao-iniciada", backupDir: bk, preRestoreDir: lado,
    tinhaArquivos: false, tinhaCfg: false,
    componentes: componentes({ banco: "concluido", sidecars: "concluido" }),
  });
  const r = rodar(raiz);
  t("retomada sem flag → exit 0", r.code === 0, `code=${r.code} ${r.saida.slice(0, 300)}`);
  t("componentes pendentes concluídos", lerJournal(raiz)?.fase === "concluido", lerJournal(raiz)?.fase);
  rmSync(raiz, { recursive: true, force: true });
}

sec("W15c — retomada de rollback interrompido");
{
  const raiz = novoRaiz();
  const bk = criarBackupDir(raiz, "novo3");
  // vivo = banco do backup (apply parcial); lado = estado antigo preservado
  copyFileSync(join(bk, "mestre-rpg.db"), dbVivo(raiz));
  const lado = criarLado(raiz, "pre_restore_teste3");
  const dbVelho = abrirDb(join(lado, "mestre-rpg.db"));
  dbVelho.exec("create table marcador (value text)");
  dbVelho.prepare("insert into marcador values ('velho')").run();
  dbVelho.close();
  // journal: rollback iniciado, sidecars já revertidos, banco pendente
  gravarJournal(raiz, {
    fase: "rollback-iniciado", preRestoreDir: lado,
    tinhaArquivos: false, tinhaCfg: false,
    componentes: componentes({ sidecars: "rollback-concluido" }),
  });
  const r = rodar(raiz);
  t("retomada de rollback → exit != 0 (boot não sobe)", r.code !== 0, `code=${r.code}`);
  t("banco vivo restaurado ao estado antigo", valorBanco(raiz) === "velho", `valor=${valorBanco(raiz)}`);
  t("journal → rollback-concluido", lerJournal(raiz)?.fase === "rollback-concluido", lerJournal(raiz)?.fase);
  rmSync(raiz, { recursive: true, force: true });
}

sec("W15d — queda durante preservação (sem preRestoreDir) refaz preservação");
{
  const raiz = novoRaiz();
  const bk = criarBackupDir(raiz, "novo4");
  criarDbComSettings(raiz, { flag: JSON.stringify({ filePath: bk }) });
  gravarJournal(raiz, {
    fase: "preservacao-iniciada", backupDir: bk,
    componentes: componentes({}),
  });
  const r = rodar(raiz);
  t("retomada de preservação → exit 0", r.code === 0, `code=${r.code} ${r.saida.slice(0, 300)}`);
  t("journal concluído", lerJournal(raiz)?.fase === "concluido", lerJournal(raiz)?.fase);
  t("pre_restore criado", existsSync(lerJournal(raiz)?.preRestoreDir ?? ""));
  rmSync(raiz, { recursive: true, force: true });
}

console.log(`\n${pass} ok, ${fail} falhas`);
process.exit(fail ? 1 : 0);
