#!/usr/bin/env node
// Testes — journal externo de restauração (Issue #155, contrato).
// W14: fail-closed — nenhum erro de leitura retorna sucesso silencioso.
// W15: retomada após interrupção na aplicação e no rollback, com
// checkpoints por componente (banco, sidecars, arquivos, config, flag).
// Estado simulado injetando restauracao-externa.json como ficaria após
// uma queda real; o restaurador deve completar apenas o pendente.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, rmSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import Database from "better-sqlite3";
import { dirTeste, abrirDb } from "./teste-base.mjs";

const RAIZ_REPO = process.cwd();
const RESTAURADOR = join(RAIZ_REPO, "servidor/dist/db/aplicar-restauracao.js");
const { instalacaoId, caminhoCanonico, dirEstado, gravarReciboInstalacao, lerReciboInstalacao,
  gravarAutorizacaoBootstrap, lerAutorizacaoBootstrap, diagnosticarBootstrap } = await import("./scripts/estado-externo.mjs");
const sha256 = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");

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
  // manifesto v2 completo — o restaurador valida integralmente o backup
  const meta = (p) => ({ size: statSync(p).size, sha256: sha256(p) });
  writeFileSync(join(dir, "manifesto.json"), JSON.stringify({
    manifestoVersao: 2,
    criadoEm: new Date().toISOString(),
    banco: meta(join(dir, "mestre-rpg.db")),
    configuracao: meta(join(dir, "configuracao", "servidor.json")),
    arquivos: { "arquivos/campanha.txt": meta(join(dir, "arquivos", "campanha.txt")) },
  }, null, 2));
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
    protocoloVersao: 1, instalacaoId: ID, repoCanon: caminhoCanonico(RAIZ_REPO),
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
  t("banco inexistente SEM recibo → FAIL-CLOSED (exit != 0)", r.code !== 0, `code=${r.code} ${r.saida.slice(0, 200)}`);
  t("motivo: sem autorização/estado ambíguo", /autoriza|bootstrap|recibo|amb[ií]guo|desconhecido/i.test(r.saida), r.saida.slice(0, 250));
  rmSync(raiz, { recursive: true, force: true });
}
{
  const raiz = novoRaiz();
  // banco inexistente COM recibo permanente de instalação concluída →
  // NÃO autoriza: é "instalação existente cujo banco foi perdido" →
  // FAIL-CLOSED (autorização de primeiro bootstrap não existe —
  // produtor confiável pendente).
  gravarReciboInstalacao(RAIZ_REPO, envRaiz(raiz));
  const r = rodar(raiz);
  t("banco inexistente COM recibo → FAIL-CLOSED (banco perdido)", r.code !== 0, `code=${r.code} ${r.saida.slice(0, 200)}`);
  t("motivo: sem autorização de bootstrap", /autoriza|bootstrap|perdido|amb[ií]guo/i.test(r.saida), r.saida.slice(0, 250));
  rmSync(raiz, { recursive: true, force: true });
}
{
  const raiz = novoRaiz();
  // banco vazio (0 tabelas) SEM recibo → bloqueia
  abrirDb(dbVivo(raiz)).close();
  const r = rodar(raiz);
  t("banco vazio SEM recibo → FAIL-CLOSED (exit != 0)", r.code !== 0, `code=${r.code}`);
  rmSync(raiz, { recursive: true, force: true });
}
{
  const raiz = novoRaiz();
  // banco vazio COM recibo permanente → idem: banco vazio não é prova
  // de primeira instalação → FAIL-CLOSED.
  abrirDb(dbVivo(raiz)).close();
  gravarReciboInstalacao(RAIZ_REPO, envRaiz(raiz));
  const r = rodar(raiz);
  t("banco vazio COM recibo → FAIL-CLOSED", r.code !== 0, `code=${r.code}`);
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
  // W14 — erro de CONSULTA após a detecção do schema: a tabela
  // server_settings EXISTE (passa na checagem de sqlite_master), mas o
  // SELECT da flag falha porque as colunas key/value não existem.
  // Não é fixture vacuosa: o fluxo de fato chega à consulta e ela quebra.
  const db = abrirDb(dbVivo(raiz));
  db.exec("create table server_settings (id integer)");
  db.exec("create table marcador (value text)");
  db.prepare("insert into marcador values ('intocado')").run();
  db.close();
  const antes = sha256(dbVivo(raiz));
  const r = rodar(raiz);
  t("SELECT da flag falha após schema ok → FAIL-CLOSED (exit != 0)", r.code !== 0, `code=${r.code}`);
  t("motivo: falha ao ler flag de restauração", /falha ao ler flag/i.test(r.saida), r.saida.slice(0, 250));
  t("banco não foi alterado pela falha", sha256(dbVivo(raiz)) === antes);
  t("nenhum journal/estado externo criado", !existsSync(journalPath(raiz)));
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
  // segunda execução após conclusão: journal final não é pendente →
  // nada a fazer, saída limpa (idempotente)
  const r2 = rodar(raiz);
  t("segunda execução após conclusão → exit 0 idempotente", r2.code === 0, `code=${r2.code} ${r2.saida.slice(0, 200)}`);
  t("banco continua = backup", valorBanco(raiz) === "novo", `valor=${valorBanco(raiz)}`);
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

sec("W15e — DB ausente + journal pendente: retomada NÃO é ignorada");
{
  const raiz = novoRaiz();
  const bk = criarBackupDir(raiz, "novo5");
  // journal de aplicação pendente, mas o arquivo do banco vivo sumiu
  // (ex.: exclusão externa no meio da troca) — o restaurador NÃO pode
  // dar fast-path de "nada a restaurar": deve retomar pelo journal.
  const lado = criarLado(raiz, "pre_restore_teste5");
  gravarJournal(raiz, {
    fase: "substituicao-iniciada", backupDir: bk, preRestoreDir: lado,
    tinhaArquivos: true, tinhaCfg: false,
    componentes: componentes({ sidecars: "concluido" }),
  });
  const r = rodar(raiz);
  t("DB ausente + journal pendente → retomada (exit 0)", r.code === 0, `code=${r.code} ${r.saida.slice(0, 300)}`);
  t("banco recriado a partir do backup", valorBanco(raiz) === "novo5", `valor=${valorBanco(raiz)}`);
  t("journal → concluido", lerJournal(raiz)?.fase === "concluido", lerJournal(raiz)?.fase);
  rmSync(raiz, { recursive: true, force: true });
}
{
  const raiz = novoRaiz();
  // journal pendente de ROLLBACK + DB ausente → retoma rollback e
  // restaura o banco preservado em `lado`.
  const bk = criarBackupDir(raiz, "novo6");
  const lado = criarLado(raiz, "pre_restore_teste6", { dbSrc: null });
  // lado precisa de um banco preservado válido
  const dbLado = abrirDb(join(lado, "mestre-rpg.db"));
  dbLado.exec("create table marcador (value text)");
  dbLado.prepare("insert into marcador values ('preservado')").run();
  dbLado.close();
  gravarJournal(raiz, {
    fase: "rollback-iniciado", preRestoreDir: lado, backupDir: bk,
    tinhaArquivos: false, tinhaCfg: false,
    componentes: componentes({}),
  });
  const r = rodar(raiz);
  t("DB ausente + rollback pendente → retoma rollback (exit != 0)", r.code !== 0, `code=${r.code}`);
  t("banco preservado restaurado", valorBanco(raiz) === "preservado", `valor=${valorBanco(raiz)}`);
  t("journal → rollback-concluido", lerJournal(raiz)?.fase === "rollback-concluido", lerJournal(raiz)?.fase);
  rmSync(raiz, { recursive: true, force: true });
}

// ================= T1 — ciclo de vida do recibo de instalação =================
// O recibo prova que a instalação foi INITIALIZADA. Se o banco some ou
// é truncado DEPOIS disso, o estado é ambíguo (perda de dados?), não
// "instalação nova" — o contrato exige bloqueio, não sucesso silencioso.
sec("T1 — recibo permanente × banco ausente/truncado posterior");
{
  const raiz = novoRaiz();
  // instalação comprovada: recibo válido gravado pelo caminho real
  gravarReciboInstalacao(RAIZ_REPO, envRaiz(raiz));
  t("recibo gravado", lerReciboInstalacao(RAIZ_REPO, envRaiz(raiz)).status === "ok");
  // DB nunca existiu nesta fixture mas o recibo existe → simulamos
  // "DB removido após instalação" apagando o banco de uma instalação
  // que de fato rodou: primeiro criamos e migramos? não — cenário é
  // recibo + ausência de banco. Contrato: bloqueia.
  const r = rodar(raiz);
  t("recibo + DB ausente → BLOQUEIA (estado ambíguo)", r.code !== 0, `code=${r.code} ${r.saida.slice(0, 250)}`);
  rmSync(raiz, { recursive: true, force: true });
}
{
  const raiz = novoRaiz();
  gravarReciboInstalacao(RAIZ_REPO, envRaiz(raiz));
  // DB truncado/vazio DEPOIS da instalação: 0 tabelas não é prova de
  // novidade quando já existe recibo de inicialização concluída.
  abrirDb(dbVivo(raiz)).close(); // cria arquivo sqlite vazio (0 tabelas)
  const r = rodar(raiz);
  t("recibo + DB vazio (0 tabelas) → BLOQUEIA", r.code !== 0, `code=${r.code} ${r.saida.slice(0, 250)}`);
  rmSync(raiz, { recursive: true, force: true });
}
{
  const raiz = novoRaiz();
  // state dir INTEIRO removido após o recibo → recibo não é reutilizável:
  // sem estado externo verificável, volta a ser ambíguo → bloqueia.
  gravarReciboInstalacao(RAIZ_REPO, envRaiz(raiz));
  rmSync(stateDir(raiz), { recursive: true, force: true });
  const r = rodar(raiz);
  t("state dir removido (recibo perdido) → BLOQUEIA", r.code !== 0, `code=${r.code} ${r.saida.slice(0, 250)}`);
  rmSync(raiz, { recursive: true, force: true });
}
{
  const raiz = novoRaiz();
  // instalação NOVA de verdade: sem recibo e sem banco → bloqueia
  // (já coberto em W14, reafirmado aqui como fronteira do ciclo de vida)
  const r = rodar(raiz);
  t("sem recibo + sem banco → BLOQUEIA", r.code !== 0, `code=${r.code}`);
  rmSync(raiz, { recursive: true, force: true });
}

// ---- T1b — autorização de primeiro bootstrap (uso único) ----
// gravarAutorizacaoBootstrap é o writer do FORMATO definido para o
// produtor confiável futuro (instalador/.bat/updater — integração
// PENDENTE, Etapa 5). Usá-lo aqui testa o CONTRATO do ciclo de vida;
// NÃO declara o bootstrap real homologado ponta a ponta.
sec("T1b — autorização de bootstrap: consumo, replay e inválidas");
{
  const raiz = novoRaiz();
  const env = envRaiz(raiz);
  gravarAutorizacaoBootstrap(RAIZ_REPO, env);
  t("autorização gravada e legível", lerAutorizacaoBootstrap(RAIZ_REPO, env).status === "ok");
  // DB ausente + autorização válida → restaurador CONSOME e libera
  const r = rodar(raiz);
  t("autorização válida + DB ausente → exit 0", r.code === 0, `code=${r.code} ${r.saida.slice(0, 250)}`);
  t("autorização consumida duravelmente (rename)", lerAutorizacaoBootstrap(RAIZ_REPO, env).status === "ausente");
  t("diagnóstico pós-consumo = bootstrap-interrompido",
    diagnosticarBootstrap(RAIZ_REPO, env) === "bootstrap-interrompido");
  // replay: segunda execução NÃO pode reusar a autorização consumida
  const r2 = rodar(raiz);
  t("REPLAY: 2ª execução → BLOQUEIA (uso único)", r2.code !== 0, `code=${r2.code} ${r2.saida.slice(0, 250)}`);
  rmSync(raiz, { recursive: true, force: true });
}
{
  const raiz = novoRaiz();
  const env = envRaiz(raiz);
  abrirDb(dbVivo(raiz)).close(); // DB vazio (0 tabelas)
  gravarAutorizacaoBootstrap(RAIZ_REPO, env);
  const r = rodar(raiz);
  t("autorização válida + DB vazio → exit 0", r.code === 0, `code=${r.code} ${r.saida.slice(0, 250)}`);
  t("autorização consumida", lerAutorizacaoBootstrap(RAIZ_REPO, env).status === "ausente");
  rmSync(raiz, { recursive: true, force: true });
}
{
  const raiz = novoRaiz();
  const env = envRaiz(raiz);
  // autorização CORROMPIDA → consumo durável mas não autoriza → bloqueia
  const arqAuth = join(stateDir(raiz), "bootstrap-autorizacao.json");
  mkdirSync(stateDir(raiz), { recursive: true });
  writeFileSync(arqAuth, "{ json quebrado");
  const r = rodar(raiz);
  t("autorização corrompida + DB ausente → BLOQUEIA", r.code !== 0, `code=${r.code} ${r.saida.slice(0, 250)}`);
  t("autorização corrompida foi consumida (evidência preservada)", !existsSync(arqAuth));
  t("pós-consumo inválido → bootstrap-interrompido",
    diagnosticarBootstrap(RAIZ_REPO, env) === "bootstrap-interrompido");
  rmSync(raiz, { recursive: true, force: true });
}
{
  const raiz = novoRaiz();
  const env = envRaiz(raiz);
  // autorização de OUTRA instalação (identidade divergente) → bloqueia
  mkdirSync(stateDir(raiz), { recursive: true });
  writeFileSync(join(stateDir(raiz), "bootstrap-autorizacao.json"), JSON.stringify({
    protocoloVersao: 1, instalacaoId: "deadbeef", repoCanon: "x", tipo: "primeiro-bootstrap",
  }));
  const r = rodar(raiz);
  t("autorização divergente + DB ausente → BLOQUEIA", r.code !== 0, `code=${r.code} ${r.saida.slice(0, 250)}`);
  rmSync(raiz, { recursive: true, force: true });
}
{
  const raiz = novoRaiz();
  const env = envRaiz(raiz);
  // recibo permanente + autorização presente: recibo prova instalação
  // CONCLUÍDA → autorização de bootstrap não se aplica; DB ausente é
  // "banco perdido" → BLOQUEIA (e a autorização não é consumida).
  gravarReciboInstalacao(RAIZ_REPO, env);
  gravarAutorizacaoBootstrap(RAIZ_REPO, env);
  const r = rodar(raiz);
  t("recibo + autorização + DB ausente → BLOQUEIA (banco perdido)", r.code !== 0, `code=${r.code} ${r.saida.slice(0, 250)}`);
  t("autorização NÃO consumida quando recibo existe",
    lerAutorizacaoBootstrap(RAIZ_REPO, env).status === "ok");
  rmSync(raiz, { recursive: true, force: true });
}

// ================= W16 — manifesto obrigatório no restaurador =================
// O validador (backup-contrato.test.ts) já prova ok:false; aqui provamos o
// efeito no fluxo real: o restaurador RECUSA antes de tocar no estado vivo.
sec("W16 — backup sem manifesto/inválido é recusado antes de tocar o vivo");
{
  const raiz = novoRaiz();
  const bk = criarBackupDir(raiz, "sem manifesto");
  rmSync(join(bk, "manifesto.json"));
  criarDbComSettings(raiz, { flag: JSON.stringify({ filePath: bk }) });
  const dv = abrirDb(dbVivo(raiz));
  dv.exec("create table marcador (value text)");
  dv.prepare("insert into marcador values ('vivo-intocado')").run();
  dv.close();
  const cfgPath = join(raiz, "configuracao", "servidor.json");
  writeFileSync(cfgPath, "{\"porta\":4999}");
  const cfgAntes = readFileSync(cfgPath, "utf8");
  const r = rodar(raiz);
  t("backup sem manifesto → FAIL-CLOSED (exit != 0)", r.code !== 0, `code=${r.code} ${r.saida.slice(0, 250)}`);
  t("motivo: backup inválido/manifesto", /inválido|manifesto/i.test(r.saida), r.saida.slice(0, 250));
  t("banco vivo preserva marcador", valorBanco(raiz) === "vivo-intocado", `valor=${valorBanco(raiz)}`);
  t("configuração viva inalterada", readFileSync(join(raiz, "configuracao", "servidor.json"), "utf8") === cfgAntes);
  t("nenhuma fase de substituição gravada", !existsSync(journalPath(raiz)) || !/substituicao|rollback/.test(lerJournal(raiz)?.fase ?? ""));
  t("backup permanece intacto (não foi consumido)", existsSync(join(bk, "mestre-rpg.db")));
  rmSync(raiz, { recursive: true, force: true });
}
{
  const raiz = novoRaiz();
  const bk = criarBackupDir(raiz, "manv1");
  // manifesto íntegro em estrutura mas versão incompatível (v1)
  const man = JSON.parse(readFileSync(join(bk, "manifesto.json"), "utf8"));
  man.manifestoVersao = 1;
  writeFileSync(join(bk, "manifesto.json"), JSON.stringify(man));
  criarDbComSettings(raiz, { flag: JSON.stringify({ filePath: bk }) });
  const r = rodar(raiz);
  t("manifestoVersao=1 → FAIL-CLOSED (exit != 0)", r.code !== 0, `code=${r.code}`);
  t("motivo: versão incompatível", /manifestoVersao|inválido/i.test(r.saida), r.saida.slice(0, 250));
  rmSync(raiz, { recursive: true, force: true });
}
{
  const raiz = novoRaiz();
  const bk = criarBackupDir(raiz, "manjson");
  writeFileSync(join(bk, "manifesto.json"), "{ json quebrado");
  criarDbComSettings(raiz, { flag: JSON.stringify({ filePath: bk }) });
  const r = rodar(raiz);
  t("manifesto corrompido → FAIL-CLOSED (exit != 0)", r.code !== 0, `code=${r.code}`);
  t("motivo: manifesto ilegível/inválido", /manifesto|inválido/i.test(r.saida), r.saida.slice(0, 250));
  rmSync(raiz, { recursive: true, force: true });
}

console.log(`\n${pass} ok, ${fail} falhas`);
process.exit(fail ? 1 : 0);
