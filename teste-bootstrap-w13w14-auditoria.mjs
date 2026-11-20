#!/usr/bin/env node
// Re-homologação adversarial W13/W14 — árvore corrigida b0f5f70 (filho).
// Substitui a auditoria de 4daf8df (preservada em docs/AUDITORIA-W13W14.md).
// Cobre: A) clone limpo sem node_modules; B) evidência inconclusiva
// fail-closed; C) retomada bootstrap (após andamento E após consumo
// antes do andamento); D) verificarPortao sem efeitos colaterais;
// E) recuperação explícita; F) retry EPERM/EBUSY/EACCES.
// Fixtures 100% descartáveis; nunca toca instalação/banco reais.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, writeFileSync, readdirSync, rmSync, statSync } from "node:fs";
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
  const raiz = join(tmpdir(), `w13w14f-audit-${process.pid}-${seq++}`);
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

// ---------- A) Clone limpo sem node_modules ----------
sec("A — clone limpo: Gate 0 sem dependências");
{
  // Cópia descartável de scripts/ FORA do alcance de qualquer
  // node_modules (tmp não tem node_modules nos pais).
  const copia = join(tmpdir(), `w13w14f-clean-${process.pid}`);
  rmSync(copia, { recursive: true, force: true });
  mkdirSync(join(copia, "scripts"), { recursive: true });
  for (const f of ["bootstrap-install.mjs", "estado-externo.mjs", "boot-lock.mjs"]) {
    copyFileSync(join(RAIZ, "scripts", f), join(copia, "scripts", f));
  }
  const gateLimpo = join(copia, "scripts", "bootstrap-install.mjs");
  const { env } = fixture();
  env.MESTRE_BANCO = join(env.MESTRE_HOME, "banco", "mestre-rpg.db"); // ausente

  const r1 = rodar(gateLimpo, [], env, copia);
  t("clone limpo + banco ausente → gate exit 0 (autoriza sem sqlite)", r1.code === 0, `exit=${r1.code} ${r1.saida.slice(0, 250)}`);
  const de1 = dirEst(env, copia);
  const authExiste = existsSync(de1) && readdirSync(de1).includes("bootstrap-autorizacao.json");
  t("autorização emitida no clone limpo legítimo", authExiste);

  // Banco EXISTENTE (arquivo qualquer) sem node_modules → inconclusivo
  const f2 = fixture();
  mkdirSync(dirname(f2.env.MESTRE_BANCO), { recursive: true });
  writeFileSync(f2.env.MESTRE_BANCO, "isto nao e um sqlite");
  const r2 = rodar(gateLimpo, [], f2.env, copia);
  const de2 = dirEst(f2.env, copia);
  const auth2 = existsSync(de2) ? readdirSync(de2).includes("bootstrap-autorizacao.json") : false;
  t("clone limpo + banco existente não-inspecionável → BLOQUEIA", r2.code !== 0 && !auth2,
    `exit=${r2.code} auth=${auth2} ${r2.saida.slice(0, 250)}`);
  rmSync(copia, { recursive: true, force: true });
}

// ---------- B) Evidência inconclusiva → fail-closed ----------
sec("B — decidirPortao/sondarInstalacao: inconclusivo nunca autoriza");
{
  const base = {
    compartilhado: false, repoDir: "x", env: {}, cam: { db: "x" }, dirEstado: "x",
    banco: { estado: "ausente" }, stateProtocolo: false,
    marcador: { status: "ausente" }, recibo: { status: "ausente" },
    auth: { status: "ausente" },
    journalUpdate: { status: "ausente" }, journalRest: { status: "ausente" },
    andamento: { status: "ausente" },
    legado: { backups: false, arquivos: false }, autorizacoesConsumidas: 0,
  };
  const casos = [
    ["stateProtocolo=null", { stateProtocolo: null }],
    ["autorizacoesConsumidas=null", { autorizacoesConsumidas: null }],
    ["legado.backups=null", { legado: { backups: null, arquivos: false } }],
    ["legado.arquivos=null", { legado: { backups: false, arquivos: null } }],
    ["banco=inconclusivo", { banco: { estado: "inconclusivo", detalhe: "sem sqlite" } }],
    ["banco=ilegivel", { banco: { estado: "ilegivel", detalhe: "erro" } }],
    ["marcador=inconclusivo", { marcador: { status: "inconclusivo" } }],
    ["auth=inconclusiva", { auth: { status: "inconclusivo" } }],
  ];
  for (const [nome, patch] of casos) {
    const d = gate.decidirPortao({ ...base, ...patch });
    t(`${nome} → não autoriza`, d.acao !== "autorizar-bootstrap", `acao=${d.acao} motivo=${d.motivo}`);
  }

  // FS hostil real: backups como arquivo regular
  const { env } = fixture();
  writeFileSync(env.MESTRE_BACKUPS, "nao sou diretorio");
  const s = await gate.sondarInstalacao(RAIZ, env);
  const d = gate.decidirPortao(s);
  t("executarPortao com backups ilegível → bloqueia, sem autorização",
    d.acao !== "autorizar-bootstrap" && !(existsSync(dirEst(env)) && readdirSync(dirEst(env)).includes("bootstrap-autorizacao.json")),
    `acao=${d.acao} motivo=${d.motivo}`);
}

// ---------- C) Retomada de bootstrap ----------
sec("C1 — crash APÓS bootstrap-em-andamento gravado");
{
  const { env } = fixture();
  const de = dirEst(env);
  const g1 = rodar(GATE, [], env);
  t("gate 1 autoriza", g1.code === 0, g1.saida.slice(0, 150));
  const r1 = rodar(RESTAURADOR, [], env);
  t("restaurador 1 consome + andamento (exit 0)", r1.code === 0, r1.saida.slice(0, 200));
  t("andamento gravado", existsSync(join(de, "bootstrap-em-andamento.json")));
  // crash aqui (sem migrate) → reinício
  const g2 = rodar(GATE, [], env);
  t("gate 2: prossegue por andamento", g2.code === 0, g2.saida.slice(0, 200));
  const r2 = rodar(RESTAURADOR, [], env);
  t("restaurador 2 retoma SEM nova autorização (exit 0)", r2.code === 0, r2.saida.slice(0, 250));
  const m = rodar(MIGRADOR, [], env);
  t("migrate exit 0", m.code === 0, m.saida.slice(0, 150));
  const g3 = rodar(GATE, [], env);
  t("gate 3 adota (marcador+recibo)", g3.code === 0, g3.saida.slice(0, 200));
  t("marcador gravado", existsSync(join(env.MESTRE_PROVENIENCIA_DIR, ee.instalacaoId(RAIZ), "instalacao-marcador.json")));
}

sec("C2a — crash REAL após andamento 'autorizacao-pendente' (antes do consumo)");
{
  const { env } = fixture();
  const de = dirEst(env);
  const g1 = rodar(GATE, [], env);
  t("gate 1 autoriza", g1.code === 0, g1.saida.slice(0, 150));
  // Crash real no ponto "pendente": andamento gravado, autorização
  // AINDA válida (não consumida).
  const r1 = rodar(RESTAURADOR, [], { ...env, NODE_ENV: "test", MESTRE_BOOTSTRAP_CRASH_AFTER: "pendente" });
  t("restaurador crash exit 42 no ponto pendente", r1.code === 42, `exit=${r1.code} ${r1.saida.slice(0, 200)}`);
  t("autorização segue válida (não consumida)", existsSync(join(de, "bootstrap-autorizacao.json")));
  // Retomada: consome normalmente, completa o ciclo.
  const r2 = rodar(RESTAURADOR, [], env);
  t("retomada consome autorização pendente (exit 0)", r2.code === 0, r2.saida.slice(0, 250));
  const m = rodar(MIGRADOR, [], env);
  t("migrate exit 0", m.code === 0, m.saida.slice(0, 150));
}

sec("C2b — crash REAL após consumo, ANTES de 'autorizada' (janela eliminada)");
{
  const { env } = fixture();
  const de = dirEst(env);
  const g1 = rodar(GATE, [], env);
  t("gate 1 autoriza", g1.code === 0, g1.saida.slice(0, 150));
  // Crash real no ponto "consumida": rename one-shot JÁ aconteceu,
  // andamento ficou "pendente", "autorizada" não foi gravado.
  const r1 = rodar(RESTAURADOR, [], { ...env, NODE_ENV: "test", MESTRE_BOOTSTRAP_CRASH_AFTER: "consumida" });
  t("restaurador crash exit 42 no ponto consumida", r1.code === 42, `exit=${r1.code} ${r1.saida.slice(0, 200)}`);
  t("autorização consumida (sumiu)", !existsSync(join(de, "bootstrap-autorizacao.json")));
  t("andamento existe em etapa pendente", existsSync(join(de, "bootstrap-em-andamento.json")));
  // Retomada: NÃO pode reconsumir — resolve via validarAutorizacoesConsumidas.
  const r2 = rodar(RESTAURADOR, [], env);
  t("retomada prova consumida válida e conclui (exit 0)", r2.code === 0, r2.saida.slice(0, 300));
  const m = rodar(MIGRADOR, [], env);
  t("migrate exit 0", m.code === 0, m.saida.slice(0, 150));
  const g2 = rodar(GATE, [], env);
  t("gate final adota (marcador+recibo)", g2.code === 0, g2.saida.slice(0, 200));
}

sec("C2c — estado impossível (consumida sem andamento) segue bloqueado");
{
  const { env } = fixture();
  const de = dirEst(env);
  // Estado que o fluxo em duas fases não produz mais: autorização
  // consumida SEM nenhum bootstrap-em-andamento → diagnóstico
  // "bootstrap-interrompido" → bloqueio fail-closed.
  ee.gravarAutorizacaoBootstrap(RAIZ, env);
  ee.consumirAutorizacaoBootstrap(RAIZ, env);
  const g = rodar(GATE, [], env);
  t("gate bloqueia bootstrap-interrompido", g.code !== 0, g.saida.slice(0, 250));
  const r = rodar(RESTAURADOR, [], env);
  t("restaurador bloqueia com segurança", r.code !== 0, r.saida.slice(0, 250));
}

// ---------- D) verificarPortao sem efeitos colaterais ----------
sec("D — verificarPortao: avaliação não pode escrever");
function snapshot(raizEnv) {
  const itens = [];
  const varrer = (d) => {
    if (!existsSync(d)) return;
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      try { if (statSync(p).isDirectory()) varrer(p); else itens.push(p); } catch { /* ignora */ }
    }
  };
  varrer(raizEnv.MESTRE_STATE_DIR);
  varrer(dirname(raizEnv.MESTRE_BANCO));
  return new Set(itens);
}
{
  // journal corrompido
  const { env } = fixture();
  rodar(MIGRADOR, [], env);
  const de = dirEst(env);
  mkdirSync(de, { recursive: true });
  writeFileSync(join(de, "restauracao-externa.json"), "{lixo");
  const antes = snapshot(env);
  const v = await gate.verificarPortao({ repoDir: RAIZ, env });
  const novos = [...snapshot(env)].filter((p) => !antes.has(p));
  const sumiram = [...antes].filter((p) => !snapshot(env).has(p));
  t("journal corrompido: nenhum arquivo criado/removido", novos.length === 0 && sumiram.length === 0,
    `novos=${JSON.stringify(novos)} sumiram=${JSON.stringify(sumiram)} motivo=${v.motivo}`);
  t("journal corrompido → bloqueio fail-closed", v.seguroIniciar === false, `motivo=${v.motivo}`);

  // journal incompatível (protocoloVersao errado) — precisa de identidade válida
  const f2 = fixture();
  rodar(MIGRADOR, [], f2.env);
  const de2 = dirEst(f2.env);
  mkdirSync(de2, { recursive: true });
  writeFileSync(join(de2, "restauracao-externa.json"), JSON.stringify({
    protocoloVersao: 999, instalacaoId: ee.instalacaoId(RAIZ),
    repoCanon: ee.caminhoCanonico(RAIZ), fase: "x",
  }));
  const antes2 = snapshot(f2.env);
  const v2 = await gate.verificarPortao({ repoDir: RAIZ, env: f2.env });
  const diff2 = [...snapshot(f2.env)].filter((p) => !antes2.has(p)).concat([...antes2].filter((p) => !snapshot(f2.env).has(p)));
  t("journal incompatível: nenhum arquivo criado/removido", diff2.length === 0, `diff=${JSON.stringify(diff2)} motivo=${v2.motivo}`);

  // journal divergente (outra instalacaoId)
  const f3 = fixture();
  rodar(MIGRADOR, [], f3.env);
  const de3 = dirEst(f3.env);
  mkdirSync(de3, { recursive: true });
  writeFileSync(join(de3, "restauracao-externa.json"), JSON.stringify({
    protocoloVersao: 1, instalacaoId: "outra-instalacao", repoCanon: "/x", fase: "x",
  }));
  const antes3 = snapshot(f3.env);
  const v3 = await gate.verificarPortao({ repoDir: RAIZ, env: f3.env });
  const diff3 = [...snapshot(f3.env)].filter((p) => !antes3.has(p)).concat([...antes3].filter((p) => !snapshot(f3.env).has(p)));
  t("journal divergente: nenhum arquivo criado/removido", diff3.length === 0, `diff=${JSON.stringify(diff3)} motivo=${v3.motivo}`);

  // state dir com falha de leitura (path como arquivo)
  const f4 = fixture();
  mkdirSync(f4.env.MESTRE_STATE_DIR, { recursive: true });
  writeFileSync(join(f4.env.MESTRE_STATE_DIR, ee.instalacaoId(RAIZ)), "nao sou dir");
  const antes4 = snapshot(f4.env);
  const v4 = await gate.verificarPortao({ repoDir: RAIZ, env: f4.env });
  const diff4 = [...snapshot(f4.env)].filter((p) => !antes4.has(p)).concat([...antes4].filter((p) => !snapshot(f4.env).has(p)));
  t("state dir ilegível: nenhum arquivo criado/removido + bloqueio", diff4.length === 0 && v4.seguroIniciar === false,
    `diff=${JSON.stringify(diff4)} motivo=${v4.motivo}`);

  // banco WAL com sidecars: verificar que a inspeção não toca o original
  const f5 = fixture();
  rodar(MIGRADOR, [], f5.env);
  // força WAL + dados para gerar sidecars reais
  const { execSync } = await import("node:child_process");
  // cria -wal/-shm reais abrindo via better-sqlite3 do repo
  const Database = (await import("better-sqlite3")).default;
  const dbw = new Database(f5.env.MESTRE_BANCO);
  dbw.pragma("journal_mode = WAL");
  dbw.exec("create table se_houver(a)");
  dbw.close();
  const walAntes = existsSync(f5.env.MESTRE_BANCO + "-wal");
  const antes5 = snapshot(f5.env);
  const v5 = await gate.verificarPortao({ repoDir: RAIZ, env: f5.env });
  const diff5 = [...snapshot(f5.env)].filter((p) => !antes5.has(p)).concat([...antes5].filter((p) => !snapshot(f5.env).has(p)));
  t("banco WAL: inspeção não altera sidecars do original", diff5.length === 0, `diff=${JSON.stringify(diff5)} walAntes=${walAntes} motivo=${v5.motivo}`);
}

// ---------- E) Recuperação explícita ----------
sec("E — recuperar-estado e assumir-reinstalacao em cenários inconclusivos");
{
  // recuperarEstadoPerdido com state dir inconclusivo (path como arquivo)
  const f1 = fixture();
  // marcador ok primeiro (instalação registrada)
  ee.gravarMarcadorInstalacao(RAIZ, f1.env);
  mkdirSync(f1.env.MESTRE_STATE_DIR, { recursive: true });
  writeFileSync(join(f1.env.MESTRE_STATE_DIR, ee.instalacaoId(RAIZ)), "nao sou dir");
  let rec, recErro = null;
  try { rec = await gate.recuperarEstadoPerdido({ repoDir: RAIZ, env: f1.env }); }
  catch (e) { recErro = e; }
  const reciboEscrito = existsSync(join(f1.env.MESTRE_STATE_DIR, ee.instalacaoId(RAIZ), "instalacao-recibo.json"));
  t("recuperar-estado com state inconclusivo → recusa limpa (sem exceção, sem recibo)",
    rec?.ok === false && !reciboEscrito,
    `retorno=${JSON.stringify(rec)?.slice(0, 150)} erro=${recErro?.code ?? recErro?.message} recibo=${reciboEscrito}`);

  // assumir-reinstalacao com marcador corrompido → deve recusar
  const f2 = fixture();
  const camMarcador = join(f2.env.MESTRE_PROVENIENCIA_DIR, ee.instalacaoId(RAIZ), "instalacao-marcador.json");
  mkdirSync(dirname(camMarcador), { recursive: true });
  writeFileSync(camMarcador, "{corrompido");
  const r2 = rodar(GATE, ["assumir-reinstalacao", "--confirmar"], f2.env);
  const auth2 = existsSync(dirEst(f2.env)) ? readdirSync(dirEst(f2.env)).includes("bootstrap-autorizacao.json") : false;
  t("assumir-reinstalacao com marcador corrompido → recusa sem emitir", r2.code !== 0 && !auth2,
    `exit=${r2.code} auth=${auth2} ${r2.saida.slice(0, 200)}`);

  // assumir-reinstalacao com banco inconclusivo (path é diretório)
  const f3 = fixture();
  mkdirSync(f3.env.MESTRE_BANCO, { recursive: true }); // db path = diretório
  const r3 = rodar(GATE, ["assumir-reinstalacao", "--confirmar"], f3.env);
  const auth3 = existsSync(dirEst(f3.env)) ? readdirSync(dirEst(f3.env)).includes("bootstrap-autorizacao.json") : false;
  t("assumir-reinstalacao com banco inconclusivo → não emite autorização", !auth3,
    `exit=${r3.code} auth=${auth3} ${r3.saida.slice(0, 200)}`);
}

// ---------- F) Retry EPERM/EBUSY/EACCES ----------
sec("F — renomearComRetry: retry limitado e higiênico");
{
  const ee2 = ee;
  // sucesso após falhas transitórias
  let tent = 0;
  const renomearOk = () => { tent++; if (tent < 3) { const e = new Error("x"); e.code = "EPERM"; throw e; } };
  let dormiu = 0;
  ee2.renomearComRetry("a", "b", { renomear: renomearOk, dormir: (ms) => { dormiu += ms; }, maxTentativas: 6 });
  t("sucesso após 2 EPERM transitórios", tent === 3 && dormiu > 0, `tent=${tent} dormiu=${dormiu}`);

  // esgotamento propaga erro original
  let tent2 = 0;
  const renomearSempreFalha = () => { tent2++; const e = new Error("perma"); e.code = "EBUSY"; throw e; };
  let propagou = null;
  try { ee2.renomearComRetry("a", "b", { renomear: renomearSempreFalha, dormir: () => {}, maxTentativas: 4 }); }
  catch (e) { propagou = e; }
  t("esgotamento propaga erro original após N tentativas", propagou?.code === "EBUSY" && tent2 === 4, `tent=${tent2} code=${propagou?.code}`);

  // erro não elegível NÃO tenta de novo
  let tent3 = 0;
  const renomearEnoent = () => { tent3++; const e = new Error("noent"); e.code = "ENOENT"; throw e; };
  try { ee2.renomearComRetry("a", "b", { renomear: renomearEnoent, dormir: () => {} }); } catch { /* esperado */ }
  t("ENOENT não elegível → 1 tentativa só", tent3 === 1, `tent=${tent3}`);

  // gravarJsonAtomico: falha final limpa tmp e propaga
  const ftmp = join(tmpdir(), `w13w14f-atomic-${process.pid}`);
  rmSync(ftmp, { recursive: true, force: true });
  mkdirSync(ftmp, { recursive: true });
  const alvo = join(ftmp, "alvo.json");
  // força falha permanente via permissão não é portável — testa a API
  // pública com caminho cujo pai não pode ser criado? Alternativa:
  // monkeypatch não disponível em ESM. Validamos o contrato indireto:
  // renomearComRetry já provado; gravarJsonAtomico usa-o (coberto pelo
  // Pai em teste-bootstrap-proveniencia.mjs — aqui só higiene do tmp
  // em sucesso).
  ee2.gravarJsonAtomico(alvo, { ok: 1 });
  const depois = readdirSync(ftmp);
  t("gravarJsonAtomico sucesso: só o alvo permanece (tmp limpo)", depois.length === 1 && depois[0] === "alvo.json", JSON.stringify(depois));
}

console.log(`\n==== ${pass} ok, ${fail} falhas ====`);
process.exit(fail ? 1 : 0);
