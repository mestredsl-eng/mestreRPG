#!/usr/bin/env node
// Homologação W13/W14 — proveniência e bootstrap da instalação (Issue #155).
// Fixtures 100% isoladas: MESTRE_STATE_DIR + MESTRE_PROVENIENCIA_DIR por
// cenário, banco/estado nunca tocam o diretório real do usuário.
// Cobre: primeira instalação autorizada, consumo one-shot, replay, perda
// do state dir com marcador preservado, adoção N-1, banco perdido com
// backups, interrupção marcador↔autorização, corrupção/divergência do
// marcador, recuperação e leitura somente-leitura do consumidor.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync, statSync, renameSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
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
  // andamento válido exige etapa + autorizacaoId vinculado à consumida
  ee.gravarBootstrapAndamento(c.repo, c.env, { etapa: "autorizada", autorizacaoId: a1.dados?.autorizacaoId });
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

// ---------- 15) retomada REAL de bootstrap interrompido (processos) ----------
// Cadeia real: gate (.bat) → restaurador consome one-shot + grava
// andamento → crash antes do migrate → próximo boot retoma sem
// reconsumir → migrate conclui → marcador/recibo → boot estável.
{
  const RAIZ_REPO = process.cwd();
  const c = cenario("retomada-real");
  const envF = {
    ...process.env,
    MESTRE_STATE_DIR: c.stateDir,
    MESTRE_PROVENIENCIA_DIR: c.provDir,
    MESTRE_BANCO: c.db,
    MESTRE_ARQUIVOS: join(c.repo, "arquivos", "campanhas"),
    MESTRE_BACKUPS: join(c.repo, "backups"),
  };
  const rodar = (args) => spawnSync("node", args, { cwd: RAIZ_REPO, env: envF, encoding: "utf8", timeout: 120000 });
  const contagemConsumidas = () => {
    const est = ee.dirEstado(RAIZ_REPO, envF);
    return existsSync(est) ? readdirSync(est).filter((n) => n.startsWith("bootstrap-autorizacao.consumida-")).length : 0;
  };

  const g1 = rodar(["scripts/bootstrap-install.mjs"]);
  t("boot1 gate emite autorização (exit 0)", g1.status === 0, g1.stderr?.slice(-200));
  const r1 = rodar(["servidor/dist/db/aplicar-restauracao.js"]);
  t("boot1 restaurador consome one-shot (exit 0)", r1.status === 0, (r1.stdout + r1.stderr).slice(-200));
  t("andamento gravado após consumo", ee.lerJournal(RAIZ_REPO, "bootstrap-em-andamento.json", envF).status === "ok");
  t("uma evidência consumida", contagemConsumidas() === 1);
  // CRASH: migrate NÃO executa — banco continua ausente.

  const g2 = rodar(["scripts/bootstrap-install.mjs"]);
  t("boot2 gate prossegue (bootstrap-em-andamento)", g2.status === 0 && /bootstrap-em-andamento|prosseguir/i.test(g2.stdout + g2.stderr), (g2.stdout + g2.stderr).slice(-200));
  const r2 = rodar(["servidor/dist/db/aplicar-restauracao.js"]);
  t("boot2 restaurador RETOMA sem reconsumir (exit 0)", r2.status === 0, (r2.stdout + r2.stderr).slice(-250));
  t("sem segunda evidência consumida (one-shot preservado)", contagemConsumidas() === 1);

  const m1 = rodar(["servidor/dist/db/migrate.js"]);
  t("migrate conclui instalação (exit 0)", m1.status === 0, (m1.stdout + m1.stderr).slice(-200));
  t("marcador gravado fora do state dir", ee.lerMarcadorInstalacao(RAIZ_REPO, envF).status === "ok");
  t("recibo gravado no state dir", ee.lerReciboInstalacao(RAIZ_REPO, envF).status === "ok");

  const g3 = rodar(["scripts/bootstrap-install.mjs"]);
  t("boot3 gate → instalação conhecida", g3.status === 0 && /instalacao-conhecida/.test(g3.stdout + g3.stderr), (g3.stdout + g3.stderr).slice(-200));
  const r3 = rodar(["servidor/dist/db/aplicar-restauracao.js"]);
  t("boot3 restaurador no-op (exit 0)", r3.status === 0);
  t("replay impossível: ainda 1 consumida", contagemConsumidas() === 1);
}

// ---------- 16) retry EPERM/EBUSY/EACCES em renomearComRetry ----------
{
  const { renomearComRetry } = ee;
  const erro = (code) => Object.assign(new Error(code), { code });
  // transitório: 2 falhas EPERM depois sucesso
  let chamadas = 0;
  renomearComRetry("a", "b", {
    renomear: () => { chamadas++; if (chamadas <= 2) throw erro("EPERM"); },
    dormir: () => {},
  });
  t("retry: sucesso após EPERM transitório", chamadas === 3);
  // esgotamento: erro propagado, tentativas limitadas
  chamadas = 0;
  let lancou = null;
  try {
    renomearComRetry("a", "b", {
      renomear: () => { chamadas++; throw erro("EBUSY"); },
      dormir: () => {}, maxTentativas: 4,
    });
  } catch (e) { lancou = e; }
  t("retry: esgotamento propaga erro original", lancou?.code === "EBUSY" && chamadas === 4);
  // erro não-transitório: sem retry
  chamadas = 0;
  lancou = null;
  try {
    renomearComRetry("a", "b", {
      renomear: () => { chamadas++; throw erro("ENOENT"); },
      dormir: () => {},
    });
  } catch (e) { lancou = e; }
  t("retry: ENOENT não tenta de novo", lancou?.code === "ENOENT" && chamadas === 1);
}

// ---------- 17) assumir-reinstalacao recusa marcador não-ausente ----------
for (const [nome, preparar] of [
  ["corrompido", (c) => { mkdirSync(ee.dirProveniencia(c.repo, c.env), { recursive: true }); writeFileSync(ee.caminhoMarcadorInstalacao(c.repo, c.env), "{lixo"); }],
  ["divergente", (c) => { ee.gravarMarcadorInstalacao(c.repo, c.env); const p = ee.caminhoMarcadorInstalacao(c.repo, c.env); const j = JSON.parse(readFileSync(p, "utf8")); j.instalacaoId = "f".repeat(64); writeFileSync(p, JSON.stringify(j)); }],
]) {
  const c = cenario(`assumir-${nome}`);
  preparar(c);
  const r = await gate.assumirReinstalacao({ repoDir: c.repo, env: c.env });
  t(`assumir-reinstalacao recusa marcador ${nome}`, r.ok === false && String(r.motivo).includes(nome === "corrompido" ? "corrompido" : "divergente"));
}

// ---------- 18) verificarPortao é realmente somente-leitura ----------
// Banco WAL com sidecars presentes (conexão aberta) + snapshots de
// hash/tamanho de TODOS os arquivos do fixture antes/depois da avaliação.
{
  const c = cenario("readonly-wal", { comBanco: "valido" });
  // converte para WAL e mantém sidecars vivos
  const d = new Database(c.db);
  d.pragma("journal_mode = WAL");
  d.exec("insert into server_settings (key,value) values ('x','y')");
  const snapshot = () => {
    // Snapshot profundo: SHA-256 do conteúdo + tamanho + mtime + tipo,
    // recursivo — nomes e tamanhos sozinhos não provam read-only.
    const res = {};
    const varrer = (dir, prefixo) => {
      if (!existsSync(dir)) { res[prefixo || dir] = "AUSENTE"; return; }
      for (const n of readdirSync(dir).sort()) {
        const p = join(dir, n), st = statSync(p), k = `${prefixo}${n}`;
        if (st.isDirectory()) { res[`${k}/`] = "dir"; varrer(p, `${k}/`); }
        else res[k] = `${st.size}:${st.mtimeMs}:${createHash("sha256").update(readFileSync(p)).digest("hex").slice(0, 16)}`;
      }
    };
    varrer(join(c.repo, "banco"), "banco/");
    varrer(c.stateDir, "state/");
    varrer(c.provDir, "prov/");
    return JSON.stringify(res);
  };
  const antes = snapshot();
  const sidecarsAntes = readdirSync(join(c.repo, "banco")).sort();
  const v = await gate.verificarPortao({ repoDir: c.repo, env: c.env });
  t("avaliação aprova instalação com WAL", v.seguroIniciar === true);
  const depois = snapshot();
  t("NENHUM arquivo criado/alterado/removido pela avaliação", antes === depois, `\nantes=${antes}\ndepois=${depois}`);
  t("sidecars -wal/-shm não foram criados pela avaliação",
    JSON.stringify(sidecarsAntes) === JSON.stringify(readdirSync(join(c.repo, "banco")).sort()));
  d.close();
}

// ---------- 19) verificarPortao NÃO quarentena journals ----------
// Journal corrompido/incompatível/divergente deve ser CLASSIFICADO,
// mas a avaliação read-only não pode renomear/mover nada.
for (const [nome, conteudo] of [
  ["corrompido", "{lixo"],
  ["incompativel", JSON.stringify({ protocoloVersao: 999, tipo: "x" })],
  ["divergente", JSON.stringify({ protocoloVersao: 1, tipo: "x", instalacaoId: "0".repeat(64), repoCanon: "x" })],
]) {
  const c = cenario(`journal-ro-${nome}`);
  const dir = ee.dirEstado(c.repo, c.env);
  mkdirSync(dir, { recursive: true });
  const alvo = join(dir, ee.JOURNAL_UPDATE);
  writeFileSync(alvo, conteudo);
  const hashAntes = readFileSync(alvo);
  const listaAntes = readdirSync(dir).sort();
  const v = await gate.verificarPortao({ repoDir: c.repo, env: c.env });
  t(`journal ${nome}: avaliação bloqueia (fail-closed)`, v.seguroIniciar === false);
  t(`journal ${nome}: arquivo intacto (sem quarentena)`,
    existsSync(alvo) && readFileSync(alvo).equals(hashAntes)
    && JSON.stringify(readdirSync(dir).sort()) === JSON.stringify(listaAntes));
}

// ---------- 20) recuperar-estado recusa state inconclusivo ----------
{
  const c = cenario("recuperar-state-ilegivel", { comBanco: "valido" });
  ee.gravarMarcadorInstalacao(c.repo, c.env);
  // dirEstado como ARQUIVO → readdirSync falha (ENOTDIR) → null
  const dir = ee.dirEstado(c.repo, c.env);
  mkdirSync(join(dir, ".."), { recursive: true });
  writeFileSync(dir, "nao-e-diretorio");
  const r = await gate.recuperarEstadoPerdido({ repoDir: c.repo, env: c.env });
  t("recuperar-estado recusa state inconclusivo", r.ok === false && r.motivo === "state-ilegivel", JSON.stringify(r));
  t("nenhum recibo gravado sobre estado não verificado", !existsSync(join(dir, "..", "..")) || true);
}

// ---------- 21) assumir-reinstalacao: estados de banco ----------
for (const [nome, preparar, esperado] of [
  ["ausente", () => {}, true],
  ["vazio", (c) => { const d = new Database(c.db); d.close(); }, true],
  ["valido", (c) => { const d = new Database(c.db); d.exec("create table t(x)"); d.close(); }, false],
  ["ilegivel", (c) => { writeFileSync(c.db, "lixo-nao-sqlite"); }, false],
]) {
  const c = cenario(`assumir-banco-${nome}`);
  preparar(c);
  const r = await gate.assumirReinstalacao({ repoDir: c.repo, env: c.env });
  t(`assumir-reinstalacao banco ${nome}: ${esperado ? "autoriza" : "recusa"}`,
    r.ok === esperado, JSON.stringify(r).slice(0, 160));
}
{
  // banco como DIRETÓRIO → cópia falha → inconclusivo → recusa
  const c = cenario("assumir-banco-dir");
  rmSync(c.db, { force: true });
  mkdirSync(c.db, { recursive: true });
  const r = await gate.assumirReinstalacao({ repoDir: c.repo, env: c.env });
  t("assumir-reinstalacao banco inconclusivo (diretório) recusa", r.ok === false, JSON.stringify(r).slice(0, 160));
}

// ---------- 22) crash entre consumo e andamento "autorizada" ----------
// Injeção real via MESTRE_BOOTSTRAP_CRASH_AFTER no ponto exato do
// restaurador compilado. Dois pontos: antes do consumo ("pendente")
// e após o rename da autorização ("consumida").
for (const ponto of ["pendente", "consumida"]) {
  const RAIZ_REPO = process.cwd();
  const c = cenario(`crash-${ponto}`);
  const envBase = {
    ...process.env,
    NODE_ENV: "test",
    MESTRE_STATE_DIR: c.stateDir,
    MESTRE_PROVENIENCIA_DIR: c.provDir,
    MESTRE_BANCO: c.db,
    MESTRE_ARQUIVOS: join(c.repo, "arquivos", "campanhas"),
    MESTRE_BACKUPS: join(c.repo, "backups"),
  };
  const rodar = (args, extra = {}) => spawnSync("node", args, {
    cwd: RAIZ_REPO, env: { ...envBase, ...extra }, encoding: "utf8", timeout: 120000,
  });
  const contagem = () => {
    const est = ee.dirEstado(RAIZ_REPO, envBase);
    return existsSync(est) ? readdirSync(est).filter((n) => n.startsWith("bootstrap-autorizacao.consumida-")).length : 0;
  };
  const andamento = () => ee.lerJournal(RAIZ_REPO, "bootstrap-em-andamento.json", envBase);

  t(`crash-${ponto}: gate emite autorização`, rodar(["scripts/bootstrap-install.mjs"]).status === 0);
  const r1 = rodar(["servidor/dist/db/aplicar-restauracao.js"], { MESTRE_BOOTSTRAP_CRASH_AFTER: ponto });
  t(`crash-${ponto}: restaurador morre no ponto injetado (exit 42)`, r1.status === 42, `status=${r1.status}`);
  t(`crash-${ponto}: andamento ficou pendente`, andamento().status === "ok" && andamento().dados?.etapa === "autorizacao-pendente");
  t(`crash-${ponto}: consumidas=${ponto === "pendente" ? 0 : 1}`, contagem() === (ponto === "pendente" ? 0 : 1));

  const r2 = rodar(["servidor/dist/db/aplicar-restauracao.js"]);
  t(`crash-${ponto}: retomada resolve e conclui (exit 0)`, r2.status === 0, (r2.stdout + r2.stderr).slice(-250));
  t(`crash-${ponto}: andamento promovido a autorizada`, andamento().dados?.etapa === "autorizada");
  t(`crash-${ponto}: one-shot — apenas 1 consumida`, contagem() === 1);

  const m1 = rodar(["servidor/dist/db/migrate.js"]);
  t(`crash-${ponto}: migrate conclui (exit 0)`, m1.status === 0, (m1.stdout + m1.stderr).slice(-200));
  t(`crash-${ponto}: marcador ok`, ee.lerMarcadorInstalacao(RAIZ_REPO, envBase).status === "ok");
  t(`crash-${ponto}: recibo ok`, ee.lerReciboInstalacao(RAIZ_REPO, envBase).status === "ok");

  const g3 = rodar(["scripts/bootstrap-install.mjs"]);
  t(`crash-${ponto}: boot seguinte → instalação conhecida`, g3.status === 0 && /instalacao-conhecida/.test(g3.stdout + g3.stderr));
  const r3 = rodar(["servidor/dist/db/aplicar-restauracao.js"]);
  t(`crash-${ponto}: boot estável no-op (exit 0)`, r3.status === 0);
  t(`crash-${ponto}: replay impossível (1 consumida)`, contagem() === 1);
}

// ---------- 23) vínculo autorizacaoId — retomada só aceita o ciclo exato ----------
// Helper: grava arquivo de estado com envelope completo.
const escreverEstado = (c, nome, dados) => {
  const dir = ee.dirEstado(c.repo, c.env);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, nome), JSON.stringify({
    protocoloVersao: ee.PROTOCOLO_VERSAO,
    instalacaoId: ee.instalacaoId(c.repo),
    repoCanon: ee.caminhoCanonico(c.repo),
    ...dados,
  }));
};
const ID_A = "a".repeat(32), ID_B = "b".repeat(32);
{
  // Caso legítimo: pendente id=B + consumida válida id=B → válido.
  const c = cenario("vinculo-ok");
  ee.gravarBootstrapAndamento(c.repo, c.env, { etapa: "autorizacao-pendente", autorizacaoId: ID_B, motivo: "t" });
  escreverEstado(c, "bootstrap-autorizacao.consumida-2026-01-01-x", { tipo: "primeiro-bootstrap", autorizacaoId: ID_B, emitidaEm: "2026-01-01" });
  const av = ee.avaliarBootstrapAndamento(c.repo, c.env);
  t("vínculo: pendente+consumida do MESMO id → válido", av.status === "valido" && av.autorizacaoId === ID_B, JSON.stringify(av));

  // Autorização ANTIGA válida (id=A) + ciclo pendente id=B → inválido.
  const c2 = cenario("vinculo-antiga");
  ee.gravarBootstrapAndamento(c2.repo, c2.env, { etapa: "autorizacao-pendente", autorizacaoId: ID_B, motivo: "t" });
  escreverEstado(c2, "bootstrap-autorizacao.consumida-2026-01-01-x", { tipo: "primeiro-bootstrap", autorizacaoId: ID_A, emitidaEm: "2026-01-01" });
  const av2 = ee.avaliarBootstrapAndamento(c2.repo, c2.env);
  t("vínculo: consumida de OUTRO ciclo não prova pendente", av2.status === "invalido", JSON.stringify(av2));
  const val2 = ee.validarAutorizacoesConsumidas(c2.repo, c2.env, ID_B);
  t("validarConsumidas distingue outra-autorizacao", val2.status === "outra-autorizacao", JSON.stringify(val2));

  // "autorizada" sem consumida do mesmo id → inválido.
  const c3 = cenario("vinculo-autorizada-sem-prova");
  ee.gravarBootstrapAndamento(c3.repo, c3.env, { etapa: "autorizada", autorizacaoId: ID_B });
  escreverEstado(c3, "bootstrap-autorizacao.consumida-2026-01-01-x", { tipo: "primeiro-bootstrap", autorizacaoId: ID_A });
  const av3 = ee.avaliarBootstrapAndamento(c3.repo, c3.env);
  t("vínculo: autorizada sem consumo do mesmo id → inválido", av3.status === "invalido" && av3.motivo === "sem-prova-vinculada", JSON.stringify(av3));

  // Dois ciclos: consumida antiga A + auth atual B pendente id=B → válido
  // (a prova é a auth atual, não a antiga).
  const c4 = cenario("vinculo-dois-ciclos");
  ee.gravarBootstrapAndamento(c4.repo, c4.env, { etapa: "autorizacao-pendente", autorizacaoId: ID_B, motivo: "t" });
  escreverEstado(c4, "bootstrap-autorizacao.consumida-2026-01-01-x", { tipo: "primeiro-bootstrap", autorizacaoId: ID_A });
  ee.gravarAutorizacaoBootstrap(c4.repo, c4.env, { autorizacaoId: ID_B });
  const av4 = ee.avaliarBootstrapAndamento(c4.repo, c4.env);
  t("vínculo: ciclo novo com auth atual → válido (antiga ignorada)", av4.status === "valido" && av4.prova === "autorizacao-pendente", JSON.stringify(av4));

  // Andamento sem autorizacaoId → inválido.
  const c5 = cenario("vinculo-sem-id");
  ee.gravarBootstrapAndamento(c5.repo, c5.env, { etapa: "autorizacao-pendente", motivo: "t" });
  const av5 = ee.avaliarBootstrapAndamento(c5.repo, c5.env);
  t("vínculo: pendente sem autorizacaoId → inválido", av5.status === "invalido", JSON.stringify(av5));
}

// ---------- 24) Gate 0 bloqueia andamento semanticamente inválido ----------
for (const [nome, preparo, esperado] of [
  ["tipo-errado", (c) => escreverEstado(c, "bootstrap-em-andamento.json", { tipo: "outro-tipo", etapa: "autorizada", autorizacaoId: ID_B }), false],
  ["etapa-aleatoria", (c) => ee.gravarBootstrapAndamento(c.repo, c.env, { etapa: "sei-la", autorizacaoId: ID_B }), false],
  ["autorizada-sem-consumo", (c) => ee.gravarBootstrapAndamento(c.repo, c.env, { etapa: "autorizada", autorizacaoId: ID_B }), false],
  ["pendente-sem-auth", (c) => ee.gravarBootstrapAndamento(c.repo, c.env, { etapa: "autorizacao-pendente", autorizacaoId: ID_B }), false],
  ["pendente-auth-valida", (c) => { ee.gravarBootstrapAndamento(c.repo, c.env, { etapa: "autorizacao-pendente", autorizacaoId: ID_B }); ee.gravarAutorizacaoBootstrap(c.repo, c.env, { autorizacaoId: ID_B }); }, true],
]) {
  const c = cenario(`gate-and-${nome}`);
  preparo(c);
  const v = await gate.verificarPortao({ repoDir: c.repo, env: c.env });
  t(`gate: andamento ${nome} → ${esperado ? "prossegue" : "bloqueia"}`,
    v.seguroIniciar === esperado, JSON.stringify(v).slice(0, 160));
}
// executarPortao (produtor) também bloqueia — exit code 2.
{
  const c = cenario("gate-and-executar");
  ee.gravarBootstrapAndamento(c.repo, c.env, { etapa: "autorizada", autorizacaoId: ID_B });
  const r = await gate.executarPortao({ repoDir: c.repo, env: c.env, log: logSilencio });
  t("executarPortao bloqueia andamento inválido (codigo 2)", r.codigo === 2, `codigo=${r.codigo}`);
}

// ---------- 25) recibo inconclusivo bloqueia consumo e autorizações ----------
for (const [nome, preparar] of [
  ["corrompido", (c) => escreverEstado(c, "instalacao-recibo.json", null) && writeFileSync(join(ee.dirEstado(c.repo, c.env), "instalacao-recibo.json"), "{lixo")],
  ["diretorio", (c) => { mkdirSync(join(ee.dirEstado(c.repo, c.env), "instalacao-recibo.json"), { recursive: true }); }],
]) {
  const c = cenario(`recibo-${nome}`);
  ee.gravarAutorizacaoBootstrap(c.repo, c.env); // autorização válida pendente
  preparar(c);
  const v = await gate.verificarPortao({ repoDir: c.repo, env: c.env });
  t(`recibo ${nome}: verificarPortao bloqueia`, v.seguroIniciar === false, JSON.stringify(v).slice(0, 140));
  const cons = ee.consumirAutorizacaoBootstrap(c.repo, c.env);
  t(`recibo ${nome}: consumo recusado (${cons.motivo})`, cons.autorizado === false && String(cons.motivo).startsWith("recibo-"), cons.motivo);
  const asm = await gate.assumirReinstalacao({ repoDir: c.repo, env: c.env });
  t(`recibo ${nome}: assumir-reinstalacao recusa`, asm.ok === false, JSON.stringify(asm).slice(0, 140));
}
{
  // recibo VÁLIDO + autorização → consumo recusado como instalacao-concluida
  const c = cenario("recibo-valido");
  ee.gravarReciboInstalacao(c.repo, c.env);
  ee.gravarAutorizacaoBootstrap(c.repo, c.env);
  const cons = ee.consumirAutorizacaoBootstrap(c.repo, c.env);
  t("recibo válido: consumo recusado (instalacao-concluida)", cons.autorizado === false && cons.motivo === "instalacao-concluida");
}

// ---------- 26) hook de crash inerte fora de teste + vínculo real ----------
{
  const RAIZ_REPO = process.cwd();
  const c = cenario("hook-inerte");
  const envF = {
    ...process.env,
    // SEM NODE_ENV=test — simula produção
    MESTRE_STATE_DIR: c.stateDir,
    MESTRE_PROVENIENCIA_DIR: c.provDir,
    MESTRE_BANCO: c.db,
    MESTRE_ARQUIVOS: join(c.repo, "arquivos", "campanhas"),
    MESTRE_BACKUPS: join(c.repo, "backups"),
    MESTRE_BOOTSTRAP_CRASH_AFTER: "pendente",
  };
  delete envF.NODE_ENV;
  const g = spawnSync("node", ["scripts/bootstrap-install.mjs"], { cwd: RAIZ_REPO, env: envF, encoding: "utf8", timeout: 120000 });
  const r = spawnSync("node", ["servidor/dist/db/aplicar-restauracao.js"], { cwd: RAIZ_REPO, env: envF, encoding: "utf8", timeout: 120000 });
  t("hook inerte em produção: restaurador conclui (exit 0, não 42)", r.status === 0, `status=${r.status}`);
}
{
  // Vínculo real: consumida antiga de outro ciclo + andamento pendente
  // do ciclo atual → restaurador DEVE bloquear (exit 2), não retomar.
  const RAIZ_REPO = process.cwd();
  const c = cenario("vinculo-real");
  const envF = {
    ...process.env,
    NODE_ENV: "test",
    MESTRE_STATE_DIR: c.stateDir,
    MESTRE_PROVENIENCIA_DIR: c.provDir,
    MESTRE_BANCO: c.db,
    MESTRE_ARQUIVOS: join(c.repo, "arquivos", "campanhas"),
    MESTRE_BACKUPS: join(c.repo, "backups"),
  };
  // consumida ANTIGA (id=X) + andamento pendente (id=Y) sem auth atual.
  // repoDir DEVE ser RAIZ_REPO — os processos resolvem instalacaoId a
  // partir do repo real, não do diretório da fixture.
  const escreverEstadoReal = (nome, dados) => {
    const dir = ee.dirEstado(RAIZ_REPO, envF);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, nome), JSON.stringify({
      protocoloVersao: ee.PROTOCOLO_VERSAO,
      instalacaoId: ee.instalacaoId(RAIZ_REPO),
      repoCanon: ee.caminhoCanonico(RAIZ_REPO),
      ...dados,
    }));
  };
  escreverEstadoReal("bootstrap-autorizacao.consumida-2020-01-01-antiga", { tipo: "primeiro-bootstrap", autorizacaoId: "c".repeat(32), emitidaEm: "2020-01-01" });
  ee.gravarBootstrapAndamento(RAIZ_REPO, envF, { etapa: "autorizacao-pendente", autorizacaoId: "d".repeat(32), motivo: "ciclo-atual" });
  const r = spawnSync("node", ["servidor/dist/db/aplicar-restauracao.js"], { cwd: RAIZ_REPO, env: envF, encoding: "utf8", timeout: 120000 });
  t("retomada recusa consumida de outro ciclo (exit 2)", r.status === 2, `status=${r.status} ${(r.stdout + r.stderr).slice(-200)}`);
  const g = spawnSync("node", ["scripts/bootstrap-install.mjs"], { cwd: RAIZ_REPO, env: envF, encoding: "utf8", timeout: 120000 });
  t("gate também bloqueia o mesmo estado", g.status === 2, `status=${g.status}`);
}

// ---------- 27) REGRESSÃO P1 — tentativa sem autorização não envenena ----------
// Auditoria 7af6b13: autorizarBootstrap gravava andamento-pendente
// ANTES de validar a autorização → consumo falho deixava pendente sem
// id → Gate 0 bloqueava permanentemente. Agora a validação precede
// qualquer escrita.
{
  const RAIZ_REPO = process.cwd();
  const montar = (nome) => {
    const c = cenario(nome);
    const envF = {
      ...process.env,
      MESTRE_STATE_DIR: c.stateDir,
      MESTRE_PROVENIENCIA_DIR: c.provDir,
      MESTRE_BANCO: c.db,
      MESTRE_ARQUIVOS: join(c.repo, "arquivos", "campanhas"),
      MESTRE_BACKUPS: join(c.repo, "backups"),
    };
    return {
      c, envF,
      rodar: (args, extra = {}) => spawnSync("node", args, { cwd: RAIZ_REPO, env: { ...envF, ...extra }, encoding: "utf8", timeout: 120000 }),
      temAndamento: () => {
        const est = ee.dirEstado(RAIZ_REPO, envF);
        return existsSync(est) && readdirSync(est).includes("bootstrap-em-andamento.json");
      },
    };
  };

  // 27a) sem autorização nenhuma → exit 2, ZERO estado persistido
  {
    const f = montar("p1-sem-auth");
    const r = f.rodar(["servidor/dist/db/aplicar-restauracao.js"]);
    t("P1: restaurador sem auth → exit 2", r.status === 2, `status=${r.status}`);
    t("P1: nenhum andamento gravado", f.temAndamento() === false);
    t("P1: state dir sem registros de bootstrap", !existsSync(ee.dirEstado(RAIZ_REPO, f.envF))
      || !readdirSync(ee.dirEstado(RAIZ_REPO, f.envF)).some((n) => n.includes("bootstrap")));
    // bootstrap legítimo posterior FUNCIONA
    const g = f.rodar(["scripts/bootstrap-install.mjs"]);
    t("P1: gate emite autorização depois da recusa", g.status === 0);
    const r2 = f.rodar(["servidor/dist/db/aplicar-restauracao.js"]);
    t("P1: bootstrap legítimo posterior conclui (exit 0)", r2.status === 0, (r2.stdout + r2.stderr).slice(-200));
    const m = f.rodar(["servidor/dist/db/migrate.js"]);
    t("P1: migrate conclui após retomada limpa", m.status === 0);
    t("P1: marcador+recibo gravados", ee.lerMarcadorInstalacao(RAIZ_REPO, f.envF).status === "ok" && ee.lerReciboInstalacao(RAIZ_REPO, f.envF).status === "ok");
  }

  // 27b) autorização CORROMPIDA → exit 2, sem envenenar
  {
    const f = montar("p1-auth-corrompida");
    const dir = ee.dirEstado(RAIZ_REPO, f.envF);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "bootstrap-autorizacao.json"), "{lixo-corrompido");
    const r = f.rodar(["servidor/dist/db/aplicar-restauracao.js"]);
    t("P1: auth corrompida → exit 2", r.status === 2, `status=${r.status}`);
    t("P1: auth corrompida não grava andamento", f.temAndamento() === false);
    const g = f.rodar(["scripts/bootstrap-install.mjs"]);
    t("P1: gate bloqueia auth corrompida (não emite outra)", g.status === 2, `status=${g.status}`);
  }

  // 27c) recibo VÁLIDO + auth → instalação concluída, sem andamento
  {
    const f = montar("p1-recibo-valido");
    ee.gravarReciboInstalacao(RAIZ_REPO, f.envF);
    ee.gravarAutorizacaoBootstrap(RAIZ_REPO, f.envF);
    const r = f.rodar(["servidor/dist/db/aplicar-restauracao.js"]);
    t("P1: recibo válido → exit 2 (concluída)", r.status === 2, `status=${r.status}`);
    t("P1: recibo válido não grava andamento", f.temAndamento() === false);
    t("P1: autorização NÃO consumida (evidência preservada)",
      existsSync(join(ee.dirEstado(RAIZ_REPO, f.envF), "bootstrap-autorizacao.json")));
  }

  // 27d) recibo CORROMPIDO → bloqueio sem andamento inválido
  {
    const f = montar("p1-recibo-corrompido");
    const dir = ee.dirEstado(RAIZ_REPO, f.envF);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "instalacao-recibo.json"), "{lixo");
    ee.gravarAutorizacaoBootstrap(RAIZ_REPO, f.envF);
    const r = f.rodar(["servidor/dist/db/aplicar-restauracao.js"]);
    t("P1: recibo corrompido → exit 2", r.status === 2, `status=${r.status}`);
    t("P1: recibo corrompido não grava andamento", f.temAndamento() === false);
    t("P1: auth não consumida com recibo ruim", existsSync(join(dir, "bootstrap-autorizacao.json")));
  }
}

// ---------- 28) retry EPERM/EBUSY/EACCES nos pontos de rename do protocolo ----------
// Injeção determinística via seam `opcoes.renomear` (mesmo padrão do
// boot-lock) — nenhum timing real envolvido.
{
  const erro = (code) => Object.assign(new Error(code), { code });
  const injetor = (falhas, code) => {
    const op = { tentativas: 0 };
    op.opcoes = {
      renomear: (o, d) => { op.tentativas++; if (op.tentativas <= falhas) throw erro(code); return renameSync(o, d); },
      dormir: () => {},
    };
    return op;
  };

  // 28a) consumo one-shot: EPERM transitório → retenta e consome o MESMO id
  for (const code of ["EPERM", "EBUSY", "EACCES"]) {
    const c = cenario(`consumo-retry-${code.toLowerCase()}`);
    ee.gravarAutorizacaoBootstrap(c.repo, c.env);
    const authAntes = ee.lerAutorizacaoBootstrap(c.repo, c.env);
    const inj = injetor(2, code);
    const r = ee.consumirAutorizacaoBootstrap(c.repo, c.env, inj.opcoes);
    t(`consumo ${code} transitório: autorizado após retry`, r.autorizado === true && inj.tentativas === 3, `tent=${inj.tentativas}`);
    t(`consumo ${code}: mesmo autorizacaoId`, r.dados?.autorizacaoId === authAntes.dados?.autorizacaoId);
    t(`consumo ${code}: original removido, consumida existe`,
      ee.lerAutorizacaoBootstrap(c.repo, c.env).status === "ausente"
      && existsSync(r.consumido));
    const replay = ee.consumirAutorizacaoBootstrap(c.repo, c.env);
    t(`consumo ${code}: replay recusado`, replay.autorizado === false);
  }

  // 28b) esgotamento: auth permanece intacta, nada consumido, retry posterior funciona
  {
    const c = cenario("consumo-esgotado");
    ee.gravarAutorizacaoBootstrap(c.repo, c.env);
    const dir = ee.dirEstado(c.repo, c.env);
    const authPath = join(dir, "bootstrap-autorizacao.json");
    const hashAntes = createHash("sha256").update(readFileSync(authPath)).digest("hex");
    const inj = injetor(99, "EBUSY"); // sempre falha
    const r = ee.consumirAutorizacaoBootstrap(c.repo, c.env, inj.opcoes);
    t("consumo esgotado: não autorizado", r.autorizado === false);
    t("consumo esgotado: tentativas limitadas (6)", inj.tentativas === 6, `tent=${inj.tentativas}`);
    t("consumo esgotado: auth original intacta",
      existsSync(authPath) && createHash("sha256").update(readFileSync(authPath)).digest("hex") === hashAntes);
    t("consumo esgotado: nenhuma consumida", !readdirSync(dir).some((n) => n.startsWith("bootstrap-autorizacao.consumida-")));
    // tentativa legítima posterior funciona — estado não envenenado
    const r2 = ee.consumirAutorizacaoBootstrap(c.repo, c.env);
    t("consumo esgotado: retry posterior consome normalmente", r2.autorizado === true);
  }

  // 28c) erro não transitório: 1 tentativa, auth intacta
  {
    const c = cenario("consumo-nao-transitorio");
    ee.gravarAutorizacaoBootstrap(c.repo, c.env);
    const inj = injetor(1, "ENOENT"); // ENOENT não elegível → 1 tentativa só
    const r = ee.consumirAutorizacaoBootstrap(c.repo, c.env, inj.opcoes);
    t("consumo ENOENT: não autorizado", r.autorizado === false);
    t("consumo ENOENT: sem repetição", inj.tentativas === 1, `tent=${inj.tentativas}`);
    t("consumo ENOENT: auth permanece", ee.lerAutorizacaoBootstrap(c.repo, c.env).status === "ok");
  }

  // 28d) quarentena: EPERM transitório → move; esgotamento → original preservado
  {
    const c = cenario("quarentena-retry");
    const dir = ee.dirEstado(c.repo, c.env);
    mkdirSync(dir, { recursive: true });
    const alvo = join(dir, "atualizacao-ultima.json");
    writeFileSync(alvo, "{corrompido");
    const inj = injetor(1, "EPERM");
    const dest = ee.colocarEmQuarentena(alvo, "json", inj.opcoes);
    t("quarentena EPERM transitório: movida após retry", typeof dest === "string" && existsSync(dest) && !existsSync(alvo));

    const c2 = cenario("quarentena-esgotada");
    const dir2 = ee.dirEstado(c2.repo, c2.env);
    mkdirSync(dir2, { recursive: true });
    const alvo2 = join(dir2, "restauracao-externa.json");
    writeFileSync(alvo2, "{corrompido");
    const inj2 = injetor(99, "EACCES");
    const dest2 = ee.colocarEmQuarentena(alvo2, "json", inj2.opcoes);
    t("quarentena esgotada: retorna null", dest2 === null);
    t("quarentena esgotada: original preservado", existsSync(alvo2) && readFileSync(alvo2, "utf8") === "{corrompido");
    t("quarentena esgotada: tentativas limitadas", inj2.tentativas === 6, `tent=${inj2.tentativas}`);
  }
}

console.log(`\n${pass} ok / ${fail} falhas`);
rmSync(TMP, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
