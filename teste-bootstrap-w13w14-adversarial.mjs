#!/usr/bin/env node
// Auditoria adversarial FINAL W13/W14 — autorização antiga × ciclo novo,
// estrutura do andamento, recibo inconclusivo, hook de crash e
// read-only com hash integral. Executado primeiro contra cc8acb1
// (pré-correções do Pai) para evidenciar defeitos; reexecutar na
// árvore final do Pai.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, statSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { pathToFileURL } from "node:url";

const RAIZ = process.cwd();
const GATE = join(RAIZ, "scripts", "bootstrap-install.mjs");
const RESTAURADOR = join(RAIZ, "servidor", "dist", "db", "aplicar-restauracao.js");
const MIGRADOR = join(RAIZ, "servidor", "dist", "db", "migrate.js");

let pass = 0, fail = 0;
const t = (n, c, extra = "") => { if (c) { pass++; console.log("  ok", n); } else { fail++; console.log("  FALHOU", n, extra); } };
const sec = (n) => console.log("\n== " + n + " ==");

const ee = await import(pathToFileURL(join(RAIZ, "scripts", "estado-externo.mjs")).href);
const gate = await import(pathToFileURL(GATE).href);

let seq = 0;
function fixture() {
  const raiz = join(tmpdir(), `w14adv-${process.pid}-${seq++}`);
  rmSync(raiz, { recursive: true, force: true });
  mkdirSync(raiz, { recursive: true });
  const env = {
    ...process.env,
    MESTRE_HOME: raiz,
    MESTRE_BANCO: join(raiz, "banco", "mestre-rpg.db"),
    MESTRE_ARQUIVOS: join(raiz, "arquivos", "campanhas"),
    MESTRE_BACKUPS: join(raiz, "backups"),
    MESTRE_STATE_DIR: join(raiz, "state"),
    MESTRE_PROVENIENCIA_DIR: join(raiz, "proveniencia"),
  };
  return { raiz, env };
}
const rodar = (script, args, env, cwd) => {
  const r = spawnSync("node", [script, ...args], { env, encoding: "utf8", cwd });
  return { code: r.status, saida: (r.stdout ?? "") + (r.stderr ?? "") };
};
const dirEst = (env, repoDir = RAIZ) => join(env.MESTRE_STATE_DIR, ee.instalacaoId(repoDir));
const nomeAndamento = ee.ARQUIVO_BOOTSTRAP_ANDAMENTO ?? "bootstrap-em-andamento.json";
const consumidas = (env) => {
  const d = dirEst(env);
  return existsSync(d) ? readdirSync(d).filter((n) => n.startsWith("bootstrap-autorizacao.consumida-")) : [];
};

// ---------- 2) Autorização antiga nunca valida ciclo novo ----------
sec("2 — autorização consumida de ciclo A não pode validar ciclo B");
{
  // Ciclo A: autorização emitida → crash real após consumo → retomada
  // legítima conclui → migrate → adoção. consumida-A permanece.
  const { env } = fixture();
  const de = dirEst(env);
  rodar(GATE, [], env);
  const rA = rodar(RESTAURADOR, [], { ...env, NODE_ENV: "test", MESTRE_BOOTSTRAP_CRASH_AFTER: "consumida" });
  t("setup A: crash pós-consumo (exit 42)", rA.code === 42, `exit=${rA.code}`);
  const rA2 = rodar(RESTAURADOR, [], env);
  t("setup A: retomada conclui (exit 0)", rA2.code === 0, rA2.saida.slice(0, 200));
  rodar(MIGRADOR, [], env);
  rodar(GATE, [], env); // adoção: marcador+recibo+limpa andamento
  t("setup A: 1 consumida preservada", consumidas(env).length === 1, JSON.stringify(consumidas(env)));

  // Simula "perda total" do ciclo A para abrir ciclo B: remove
  // marcador, recibo e banco — consumida-A permanece no state dir.
  rmSync(join(env.MESTRE_PROVENIENCIA_DIR, ee.instalacaoId(RAIZ), "instalacao-marcador.json"), { force: true });
  rmSync(join(de, "instalacao-recibo.json"), { force: true });
  rmSync(env.MESTRE_BANCO, { force: true });
  for (const suf of ["-wal", "-shm", "-journal"]) rmSync(env.MESTRE_BANCO + suf, { force: true });

  // Ciclo B: operador assume reinstalação → autorização B emitida.
  const rB = rodar(GATE, ["assumir-reinstalacao", "--confirmar"], env);
  t("setup B: nova autorização emitida", rB.code === 0, rB.saida.slice(0, 150));
  // B inicia: pendente gravado, depois corrompemos a autorização B e
  // removemos o arquivo para simular "B ausente".
  const rB1 = rodar(RESTAURADOR, [], { ...env, NODE_ENV: "test", MESTRE_BOOTSTRAP_CRASH_AFTER: "pendente" });
  t("setup B: crash no pendente de B (exit 42)", rB1.code === 42, `exit=${rB1.code}`);
  // remove a autorização B (ainda não consumida — crash foi antes)
  rmSync(join(de, "bootstrap-autorizacao.json"), { force: true });
  // Retomada de B: NÃO pode aceitar a consumida de A como prova.
  const rB2 = rodar(RESTAURADOR, [], env);
  t("B com autorização ausente + consumida-A → BLOQUEIA", rB2.code !== 0,
    `exit=${rB2.code} ${rB2.saida.slice(0, 300)}`);
}
{
  // Variante: B corrompida (não apenas ausente)
  const { env } = fixture();
  const de = dirEst(env);
  // Ciclo A direto: consumida-A válida
  ee.gravarAutorizacaoBootstrap(RAIZ, env);
  ee.consumirAutorizacaoBootstrap(RAIZ, env);
  t("setup: consumida-A válida", consumidas(env).length === 1);
  // Ciclo B: autorização B corrompida
  mkdirSync(de, { recursive: true });
  writeFileSync(join(de, "bootstrap-autorizacao.json"), "{quebrado");
  writeFileSync(join(de, nomeAndamento), JSON.stringify({
    protocoloVersao: 1, instalacaoId: ee.instalacaoId(RAIZ),
    repoCanon: ee.caminhoCanonico(RAIZ), tipo: "bootstrap-em-andamento",
    etapa: "autorizacao-pendente", em: new Date().toISOString(),
  }));
  const r = rodar(RESTAURADOR, [], env);
  t("B corrompida + consumida-A → BLOQUEIA", r.code !== 0, `exit=${r.code} ${r.saida.slice(0, 300)}`);
}
{
  // B consumida de verdade + crash antes de "autorizada": retomada
  // deve aceitar SOMENTE a consumida de B — se houver A válida e B
  // inválida, não pode passar pela prova de A.
  const { env } = fixture();
  const de = dirEst(env);
  // consumida-A: conteúdo VÁLIDO de uma autorização anterior
  ee.gravarAutorizacaoBootstrap(RAIZ, env, { emitidaEm: "2020-01-01T00:00:00Z", origem: "ciclo-A" });
  ee.consumirAutorizacaoBootstrap(RAIZ, env);
  const consumidaA = consumidas(env)[0];
  t("setup: consumida-A presente", Boolean(consumidaA));
  // Ciclo B real: nova autorização, pendente, consumo com crash
  // → produz consumida-B. Depois CORROMPEMOS consumida-B: a retomada
  // só poderia se apoiar em A — deve bloquear.
  ee.gravarAutorizacaoBootstrap(RAIZ, env, { emitidaEm: "2026-01-01T00:00:00Z", origem: "ciclo-B" });
  // andamento pendente de B (como o restaurador gravaria)
  ee.gravarBootstrapAndamento(RAIZ, env, { etapa: "autorizacao-pendente", motivo: "banco-ausente" });
  const consB = ee.consumirAutorizacaoBootstrap(RAIZ, env);
  t("setup: B consumida", consB.autorizado === true);
  const consumidaB = consumidas(env).find((n) => n !== consumidaA);
  t("setup: consumida-B distinta de A", Boolean(consumidaB), JSON.stringify(consumidas(env)));
  // corrompe a consumida de B
  writeFileSync(join(de, consumidaB), "{inválida");
  const r = rodar(RESTAURADOR, [], env);
  t("B consumida corrompida + A válida → BLOQUEIA (não herda A)", r.code !== 0,
    `exit=${r.code} ${r.saida.slice(0, 300)}`);
}

// ---------- 3) Estrutura do andamento ----------
sec("3 — andamento com envelope válido mas conteúdo inválido");
{
  const envBase = () => {
    const { env } = fixture();
    return env;
  };
  const montarAndamento = (env, dados) => {
    const de = dirEst(env);
    mkdirSync(de, { recursive: true });
    writeFileSync(join(de, nomeAndamento), JSON.stringify({
      protocoloVersao: 1, instalacaoId: ee.instalacaoId(RAIZ),
      repoCanon: ee.caminhoCanonico(RAIZ), ...dados,
    }));
  };
  const casos = [
    ["tipo incorreto", { tipo: "outro", etapa: "autorizada" }],
    ["tipo ausente", { etapa: "autorizada" }],
    ["etapa desconhecida", { tipo: "bootstrap-em-andamento", etapa: "etapa-x" }],
    ["etapa ausente", { tipo: "bootstrap-em-andamento" }],
    ["autorizacaoId divergente", { tipo: "bootstrap-em-andamento", etapa: "autorizada", autorizacaoId: "de-outro-ciclo" }],
  ];
  for (const [nome, dados] of casos) {
    const env = envBase();
    montarAndamento(env, dados);
    // Gate 0 deve recusar ANTES de liberar fluxo mutável
    const g = await gate.executarPortao({ repoDir: RAIZ, env, log: () => {} });
    t(`Gate0 recusa andamento: ${nome}`, g.codigo !== 0 || g.decisao?.acao !== "prosseguir",
      `codigo=${g.codigo} acao=${g.decisao?.acao} motivo=${g.decisao?.motivo}`);
  }
  // andamento válido legítimo → prossegue (controle): exige
  // autorizacaoId + prova vinculada (consumida com o mesmo id).
  const envOk = envBase();
  const AUTH_ID = "a".repeat(32);
  ee.gravarAutorizacaoBootstrap(RAIZ, envOk, { autorizacaoId: AUTH_ID });
  ee.consumirAutorizacaoBootstrap(RAIZ, envOk);
  montarAndamento(envOk, { tipo: "bootstrap-em-andamento", etapa: "autorizada", autorizacaoId: AUTH_ID });
  const gOk = await gate.executarPortao({ repoDir: RAIZ, env: envOk, log: () => {} });
  t("controle: andamento válido (id+prova) prossegue", gOk.codigo === 0, `codigo=${gOk.codigo} motivo=${gOk.decisao?.motivo}`);
}

// ---------- 4) Recibo inconclusivo ----------
sec("4 — recibo inconclusivo/corrompido nunca autoriza");
{
  const casos = [
    ["recibo corrompido", (de) => writeFileSync(join(de, "instalacao-recibo.json"), "{lixo")],
    ["recibo como diretório", (de) => mkdirSync(join(de, "instalacao-recibo.json"), { recursive: true })],
    ["recibo divergente", (de) => writeFileSync(join(de, "instalacao-recibo.json"), JSON.stringify({
      protocoloVersao: 1, instalacaoId: "outra", repoCanon: "/x", tipo: "instalacao-concluida" }))],
    ["recibo tipo inválido", (de) => writeFileSync(join(de, "instalacao-recibo.json"), JSON.stringify({
      protocoloVersao: 1, instalacaoId: ee.instalacaoId(RAIZ), repoCanon: ee.caminhoCanonico(RAIZ), tipo: "outro" }))],
  ];
  for (const [nome, montar] of casos) {
    const { env } = fixture();
    const de = dirEst(env);
    mkdirSync(de, { recursive: true });
    montar(de);
    const g = await gate.executarPortao({ repoDir: RAIZ, env, log: () => {} });
    const authExiste = readdirSync(de).includes("bootstrap-autorizacao.json");
    t(`${nome} → bloqueia sem emitir autorização`, g.codigo !== 0 && !authExiste,
      `codigo=${g.codigo} acao=${g.decisao?.acao} motivo=${g.decisao?.motivo}`);
  }
  // controle: recibo ausente + autorização válida → prossegue
  const { env } = fixture();
  ee.gravarAutorizacaoBootstrap(RAIZ, env);
  const gc = await gate.executarPortao({ repoDir: RAIZ, env, log: () => {} });
  t("controle: auth válida sem recibo → prossegue", gc.codigo === 0, `codigo=${gc.codigo}`);
}

// ---------- 5) Hook de crash: NODE_ENV ----------
sec("5 — MESTRE_BOOTSTRAP_CRASH_AFTER exige ambiente de teste");
{
  const mk = () => {
    const { env } = fixture();
    rodar(GATE, [], env);
    return env;
  };
  // NODE_ENV=test → crash real
  const e1 = mk();
  const r1 = rodar(RESTAURADOR, [], { ...e1, NODE_ENV: "test", MESTRE_BOOTSTRAP_CRASH_AFTER: "pendente" });
  t("NODE_ENV=test + hook → exit 42", r1.code === 42, `exit=${r1.code}`);
  // NODE_ENV=production → hook inerte
  const e2 = mk();
  const r2 = rodar(RESTAURADOR, [], { ...e2, NODE_ENV: "production", MESTRE_BOOTSTRAP_CRASH_AFTER: "pendente" });
  t("NODE_ENV=production + hook → inerte (exit 0)", r2.code === 0, `exit=${r2.code} ${r2.saida.slice(0, 200)}`);
  // sem NODE_ENV → comportamento normal (hook não deveria disparar fora de teste)
  const e3 = mk();
  const env3 = { ...e3, MESTRE_BOOTSTRAP_CRASH_AFTER: "pendente" };
  delete env3.NODE_ENV;
  const r3 = rodar(RESTAURADOR, [], env3);
  t("sem NODE_ENV + hook → inerte ou documentado", r3.code === 0 || r3.code === 42,
    `exit=${r3.code} ${r3.saida.slice(0, 150)}`);
}

// ---------- 6) Read-only com hash integral ----------
sec("6 — verificarPortao: snapshot com SHA-256 + mtime + tipo");
function snapshotForte(raizEnv) {
  const itens = new Map();
  const varrer = (d) => {
    if (!existsSync(d)) { itens.set("AUSENTE:" + d, "dir-ausente"); return; }
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      let st;
      try { st = lstatSync(p); } catch { itens.set(p, "lstat-falha"); continue; }
      if (st.isDirectory()) { varrer(p); continue; }
      if (st.isSymbolicLink()) { itens.set(p, "symlink"); continue; }
      const buf = readFileSync(p);
      itens.set(p, `${st.size}:${createHash("sha256").update(buf).digest("hex").slice(0, 16)}:${Math.round(st.mtimeMs)}`);
    }
  };
  varrer(raizEnv.MESTRE_STATE_DIR);
  varrer(raizEnv.MESTRE_PROVENIENCIA_DIR);
  varrer(dirname(raizEnv.MESTRE_BANCO));
  varrer(raizEnv.MESTRE_BACKUPS);
  return itens;
}
{
  const { env } = fixture();
  rodar(MIGRADOR, [], env);
  const de = dirEst(env);
  mkdirSync(de, { recursive: true });
  writeFileSync(join(de, "restauracao-externa.json"), "{lixo");
  const antes = snapshotForte(env);
  const v = await gate.verificarPortao({ repoDir: RAIZ, env });
  const depois = snapshotForte(env);
  const diffs = [];
  for (const [k, val] of antes) if (depois.get(k) !== val) diffs.push(`ALTERADO ${k}`);
  for (const k of depois.keys()) if (!antes.has(k)) diffs.push(`NOVO ${k}`);
  t("journal corrompido: hash/tamanho/mtime idênticos", diffs.length === 0, JSON.stringify(diffs).slice(0, 400));
  t("journal corrompido → bloqueio", v.seguroIniciar === false, `motivo=${v.motivo}`);
}

console.log(`\n==== ${pass} ok, ${fail} falhas ====`);
process.exit(fail ? 1 : 0);
