#!/usr/bin/env node
// Homologação W13/W14 — proveniência e bootstrap da instalação (Issue #155).
// Fixtures 100% isoladas: MESTRE_STATE_DIR + MESTRE_PROVENIENCIA_DIR por
// cenário, banco/estado nunca tocam o diretório real do usuário.
// Cobre: primeira instalação autorizada, consumo one-shot, replay, perda
// do state dir com marcador preservado, adoção N-1, banco perdido com
// backups, interrupção marcador↔autorização, corrupção/divergência do
// marcador, recuperação e leitura somente-leitura do consumidor.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

const gate = await import("./scripts/bootstrap-install.mjs");
const ee = await import("./scripts/estado-externo.mjs");

let pass = 0, fail = 0;
const t = (n, c, extra = "") => {
  if (c) { pass++; console.log("ok", n); }
  else { fail++; console.log("FALHOU", n, extra); }
};
const logSilencio = () => {};

const TMP = mkdtempSync(join(tmpdir(), "bootstrap-prov-"));
let seq = 0;

/** Monta uma fixture de "repo" isolada com overrides de caminho. */
function cenario(nome, { comBanco = "nenhum", comBackups = false, comCfg = false } = {}) {
  const id = `${seq++}-${nome}`;
  const repo = join(TMP, id, "repo");
  mkdirSync(join(repo, "banco"), { recursive: true });
  mkdirSync(join(repo, "configuracao"), { recursive: true });
  mkdirSync(join(repo, "scripts"), { recursive: true });
  if (comCfg) writeFileSync(join(repo, "configuracao", "servidor.json"), "{}");
  if (comBackups) {
    mkdirSync(join(repo, "backups"), { recursive: true });
    writeFileSync(join(repo, "backups", "bk_velho.sqlite"), "lixo");
  }
  const db = join(repo, "banco", "mestre-rpg.db");
  if (comBanco === "vazio") { const d = new Database(db); d.close(); }
  if (comBanco === "valido") {
    const d = new Database(db);
    d.exec("create table server_settings (key text primary key, value text)");
    d.close();
  }
  if (comBanco === "ilegivel") writeFileSync(db, "isto nao e sqlite!!!");
  const env = {
    MESTRE_STATE_DIR: join(TMP, id, "state"),
    MESTRE_PROVENIENCIA_DIR: join(TMP, id, "prov"),
    MESTRE_BANCO: db,
    MESTRE_ARQUIVOS: join(repo, "arquivos", "campanhas"),
    MESTRE_BACKUPS: join(repo, "backups"),
  };
  return { repo, env, db, stateDir: env.MESTRE_STATE_DIR, provDir: env.MESTRE_PROVENIENCIA_DIR };
}

// ---------- 1) primeira instalação legítima ----------
{
  const c = cenario("primeira");
  const r = await gate.executarPortao({ repoDir: c.repo, env: c.env, log: logSilencio });
  t("clone novo → autorizacao-bootstrap emitida", r.codigo === 0 && r.decisao.acao === "autorizar-bootstrap");
  t("autorizacao gravada no state dir", ee.lerAutorizacaoBootstrap(c.repo, c.env).status === "ok");
  t("marcador ainda NÃO gravado (só após prova de instalação)",
    ee.lerMarcadorInstalacao(c.repo, c.env).status === "ausente");
  t("marcador fica fora do state dir e do repo",
    !existsSync(join(c.stateDir, "instalacao-marcador.json")));
}

// ---------- 2) consumo one-shot + bootstrap-em-andamento ----------
{
  const c = cenario("consumo");
  await gate.executarPortao({ repoDir: c.repo, env: c.env, log: logSilencio });
  const a1 = ee.consumirAutorizacaoBootstrap(c.repo, c.env);
  t("primeiro consumo autorizado", a1.autorizado === true);
  ee.gravarBootstrapAndamento(c.repo, c.env, { motivo: "teste" });
  const a2 = ee.consumirAutorizacaoBootstrap(c.repo, c.env);
  t("replay da autorização recusado", a2.autorizado === false);
  t("evidência consumida preservada", readdirSync(ee.dirEstado(c.repo, c.env)).some((n) => n.startsWith("bootstrap-autorizacao.consumida-")));
  const r = await gate.executarPortao({ repoDir: c.repo, env: c.env, log: logSilencio });
  t("gate seguinte prossegue (bootstrap-em-andamento)", r.codigo === 0 && r.decisao.motivo === "bootstrap-em-andamento");
}

// ---------- 3) autorização consumida SEM andamento → ambíguo ----------
{
  const c = cenario("sem-andamento");
  await gate.executarPortao({ repoDir: c.repo, env: c.env, log: logSilencio });
  ee.consumirAutorizacaoBootstrap(c.repo, c.env);
  const r = await gate.executarPortao({ repoDir: c.repo, env: c.env, log: logSilencio });
  t("consumida sem andamento → bloqueia estado-ambiguo", r.codigo === 2 && r.decisao.motivo === "estado-ambiguo");
}

// ---------- 4) adoção N-1: banco válido sem marcador ----------
{
  const c = cenario("adocao", { comBanco: "valido" });
  const r = await gate.executarPortao({ repoDir: c.repo, env: c.env, log: logSilencio });
  t("banco válido sem marcador → adotar", r.codigo === 0 && r.decisao.acao === "adotar");
  t("marcador gravado fora do state dir", ee.lerMarcadorInstalacao(c.repo, c.env).status === "ok");
  t("marcador contém identidade completa",
    (() => { const m = JSON.parse(readFileSync(ee.caminhoMarcadorInstalacao(c.repo, c.env), "utf8")); return m.protocoloVersao === ee.PROTOCOLO_VERSAO && !!m.instalacaoId && !!m.repoCanon; })());
  t("recibo gravado no state dir", ee.lerReciboInstalacao(c.repo, c.env).status === "ok");
  const r2 = await gate.executarPortao({ repoDir: c.repo, env: c.env, log: logSilencio });
  t("segundo gate → instalação conhecida", r2.codigo === 0 && r2.decisao.motivo === "instalacao-conhecida");
}

// ---------- 5) state dir perdido após instalação → marcador preservado ----------
{
  const c = cenario("state-perdido", { comBanco: "valido" });
  await gate.executarPortao({ repoDir: c.repo, env: c.env, log: logSilencio }); // adota
  rmSync(c.stateDir, { recursive: true, force: true });
  t("state dir removido", !existsSync(c.stateDir));
  t("marcador de proveniência SOBREVIVE à perda do state dir",
    ee.lerMarcadorInstalacao(c.repo, c.env).status === "ok");
  const r = await gate.executarPortao({ repoDir: c.repo, env: c.env, log: logSilencio });
  t("gate bloqueia: estado-externo-perdido", r.codigo === 2 && r.decisao.motivo === "estado-externo-perdido");
  const rec = await gate.recuperarEstadoPerdido({ repoDir: c.repo, env: c.env });
  t("recuperar-estado explícito funciona", rec.ok === true);
  const r2 = await gate.executarPortao({ repoDir: c.repo, env: c.env, log: logSilencio });
  t("após recuperação → prossegue", r2.codigo === 0);
}

// ---------- 6) banco perdido com instalação registrada ----------
{
  const c = cenario("banco-perdido", { comBanco: "valido" });
  await gate.executarPortao({ repoDir: c.repo, env: c.env, log: logSilencio }); // adota
  rmSync(c.db);
  const r = await gate.executarPortao({ repoDir: c.repo, env: c.env, log: logSilencio });
  t("banco ausente + marcador → bloqueia banco-perdido", r.codigo === 2 && r.decisao.motivo === "banco-perdido");
}

// ---------- 7) banco ausente com backups anteriores → não é clone novo ----------
{
  const c = cenario("backups", { comBackups: true });
  const r = await gate.executarPortao({ repoDir: c.repo, env: c.env, log: logSilencio });
  t("backups/ sem banco → bloqueia possivel-instalacao-anterior", r.codigo === 2 && r.decisao.motivo === "possivel-instalacao-anterior");
  t("NENHUMA autorização emitida automaticamente", !existsSync(ee.dirEstado(c.repo, c.env)) || !readdirSync(ee.dirEstado(c.repo, c.env)).includes("bootstrap-autorizacao.json"));
  const rec = await gate.assumirReinstalacao({ repoDir: c.repo, env: c.env });
  t("assumir-reinstalacao explícito emite autorização", rec.ok === true);
}

// ---------- 8) interrupção entre marcador e autorização ----------
{
  const c = cenario("interrupcao-marcador");
  ee.gravarMarcadorInstalacao(c.repo, c.env, { origem: "teste" });
  const r = await gate.executarPortao({ repoDir: c.repo, env: c.env, log: logSilencio });
  t("marcador sem banco → banco-perdido (não vira clone novo)", r.codigo === 2 && r.decisao.motivo === "banco-perdido");
}

// ---------- 9) marcador corrompido / divergente ----------
{
  const c = cenario("marcador-corrompido", { comBanco: "valido" });
  mkdirSync(ee.dirProveniencia(c.repo, c.env), { recursive: true });
  writeFileSync(ee.caminhoMarcadorInstalacao(c.repo, c.env), "{lixo!!!");
  const r = await gate.executarPortao({ repoDir: c.repo, env: c.env, log: logSilencio });
  t("marcador corrompido → bloqueia", r.codigo === 2 && String(r.decisao.motivo).startsWith("marcador-"));
}
{
  const c = cenario("marcador-divergente", { comBanco: "valido" });
  ee.gravarMarcadorInstalacao(c.repo, c.env);
  // adultera o id gravado → identidade divergente
  const p = ee.caminhoMarcadorInstalacao(c.repo, c.env);
  const j = JSON.parse((await import("node:fs")).readFileSync(p, "utf8"));
  j.instalacaoId = "0".repeat(64);
  writeFileSync(p, JSON.stringify(j));
  const r = await gate.executarPortao({ repoDir: c.repo, env: c.env, log: logSilencio });
  t("marcador divergente → bloqueia", r.codigo === 2 && r.decisao.motivo === "marcador-divergente");
}

// ---------- 10) banco ilegível → fail-closed ----------
{
  const c = cenario("ilegivel", { comBanco: "ilegivel" });
  const r = await gate.executarPortao({ repoDir: c.repo, env: c.env, log: logSilencio });
  t("banco ilegível → bloqueia", r.codigo === 2);
}

// ---------- 11) verificarPortao é somente-leitura ----------
{
  const c = cenario("readonly");
  const v = await gate.verificarPortao({ repoDir: c.repo, env: c.env });
  t("verificarPortao aprova primeira instalação", v.seguroIniciar === true && v.acao === "autorizar-bootstrap");
  t("verificarPortao NÃO emitiu autorização (read-only)", !existsSync(ee.dirEstado(c.repo, c.env)) || !readdirSync(ee.dirEstado(c.repo, c.env)).includes("bootstrap-autorizacao.json"));
  t("verificarPortao NÃO gravou marcador", ee.lerMarcadorInstalacao(c.repo, c.env).status === "ausente");
}

// ---------- 12) journal corrompido bloqueia ----------
{
  const c = cenario("journal-corrompido", { comBanco: "valido" });
  const est = ee.dirEstado(c.repo, c.env);
  mkdirSync(est, { recursive: true });
  writeFileSync(join(est, "atualizacao-ultima.json"), "{quebrado");
  const r = await gate.executarPortao({ repoDir: c.repo, env: c.env, log: logSilencio });
  t("journal corrompido → bloqueia", r.codigo === 2);
}

// ---------- 13) recuperação completa do bootstrap interrompido ----------
{
  const c = cenario("recuperacao-bootstrap");
  await gate.executarPortao({ repoDir: c.repo, env: c.env, log: logSilencio });
  ee.consumirAutorizacaoBootstrap(c.repo, c.env);
  ee.gravarBootstrapAndamento(c.repo, c.env);
  // simula migrate concluído: banco válido aparece + adoção tardia
  const d = new Database(c.db); d.exec("create table t (x)"); d.close();
  ee.gravarMarcadorInstalacao(c.repo, c.env, { origem: "migrate-concluido" });
  ee.limparBootstrapAndamento(c.repo, c.env);
  const r = await gate.executarPortao({ repoDir: c.repo, env: c.env, log: logSilencio });
  t("bootstrap concluído → instalação conhecida", r.codigo === 0 && r.decisao.motivo === "instalacao-conhecida");
  const r2 = await gate.executarPortao({ repoDir: c.repo, env: c.env, log: logSilencio });
  t("e permanece estável no boot seguinte", r2.codigo === 0);
}

// ---------- 14) marcador protocol version incompatível ----------
{
  const c = cenario("protocolo-antigo", { comBanco: "valido" });
  mkdirSync(ee.dirProveniencia(c.repo, c.env), { recursive: true });
  writeFileSync(ee.caminhoMarcadorInstalacao(c.repo, c.env), JSON.stringify({
    protocoloVersao: 99, instalacaoId: ee.instalacaoId(c.repo), repoCanon: ee.caminhoCanonico(c.repo), tipo: "instalacao-inicializada",
  }));
  const r = await gate.executarPortao({ repoDir: c.repo, env: c.env, log: logSilencio });
  t("protocolo incompatível → bloqueia", r.codigo === 2 && r.decisao.motivo === "marcador-incompativel");
}

console.log(`\n${pass} ok / ${fail} falhas`);
rmSync(TMP, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
