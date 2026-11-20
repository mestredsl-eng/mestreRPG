#!/usr/bin/env node
// Auditoria adversarial W13/W14 — bootstrap e proveniência (filho).
// Cobre os bloqueadores reportados: clone limpo sem deps (P0, manual),
// evidência ilegível tratada como ausência (P1), retomada de
// bootstrap-em-andamento (P1), assumir-reinstalacao com marcador
// corrompido (P4) e alegação de somente-leitura do verificarPortao (P5).
// Fixtures 100% descartáveis; nunca toca instalação/banco reais.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
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
  const raiz = join(tmpdir(), `w13w14-audit-${process.pid}-${seq++}`);
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
const rodar = (script, args, env) => {
  const r = spawnSync("node", [script, ...args], { env, encoding: "utf8" });
  return { code: r.status, saida: (r.stdout ?? "") + (r.stderr ?? "") };
};

// ---------- P1a: decidirPortao com evidência inconclusiva (unidade) ----------
sec("P1a — decidirPortao: evidência inconclusiva NUNCA pode autorizar");
{
  const base = {
    compartilhado: false, repoDir: "x", env: {}, cam: { db: "x" }, dirEstado: "x",
    banco: { estado: "ausente" },
    stateProtocolo: false,
    marcador: { status: "ausente" }, recibo: { status: "ausente" },
    auth: { status: "ausente" },
    journalUpdate: { status: "ausente" }, journalRest: { status: "ausente" },
    andamento: { status: "ausente" },
    legado: { backups: false, arquivos: false },
    autorizacoesConsumidas: 0,
  };
  const casos = [
    ["stateProtocolo=null (state dir ilegível)", { stateProtocolo: null }],
    ["autorizacoesConsumidas=null (readdir falhou)", { autorizacoesConsumidas: null }],
    ["legado.backups=null (readdir backups falhou)", { legado: { backups: null, arquivos: false } }],
    ["legado.arquivos=null (readdir arquivos falhou)", { legado: { backups: false, arquivos: null } }],
  ];
  for (const [nome, patch] of casos) {
    const d = gate.decidirPortao({ ...base, ...patch });
    t(`${nome} → não autoriza bootstrap`, d.acao !== "autorizar-bootstrap", `acao=${d.acao} motivo=${d.motivo}`);
  }
}

// ---------- P1b: sondarInstalacao real — FS hostil ----------
sec("P1b — sondarInstalacao: FS hostil deve bloquear, não autorizar");
{
  // backups apontando para ARQUIVO regular → readdirSync lança → null
  const { raiz, env } = fixture();
  writeFileSync(env.MESTRE_BACKUPS, "nao sou diretorio");
  const s = await gate.sondarInstalacao(RAIZ, env);
  t("legado.backups === null em FS hostil", s.legado.backups === null, `veio ${s.legado.backups}`);
  const d = gate.decidirPortao(s);
  t("decidirPortao bloqueia (não autoriza) com backups ilegível", d.acao !== "autorizar-bootstrap", `acao=${d.acao} motivo=${d.motivo}`);

  // state dir do protocolo como ARQUIVO → readdirSync lança → null
  const f2 = fixture();
  const id = ee.instalacaoId(RAIZ);
  mkdirSync(f2.env.MESTRE_STATE_DIR, { recursive: true });
  writeFileSync(join(f2.env.MESTRE_STATE_DIR, id), "nao sou diretorio");
  const s2 = await gate.sondarInstalacao(RAIZ, f2.env);
  t("stateProtocolo === null com state path como arquivo", s2.stateProtocolo === null, `veio ${s2.stateProtocolo}`);
  const d2 = gate.decidirPortao(s2);
  t("decidirPortao bloqueia (não autoriza) com state ilegível", d2.acao !== "autorizar-bootstrap", `acao=${d2.acao} motivo=${d2.motivo}`);

  // executarPortao de verdade no cenário backups-hostil
  const r = await gate.executarPortao({ repoDir: RAIZ, env, log: () => {} });
  t("executarPortao NÃO emite autorização com backups ilegível", !(existsSync(join(env.MESTRE_STATE_DIR, id, "bootstrap-autorizacao.json"))), `codigo=${r.codigo} acao=${r.decisao?.acao}`);
}

// ---------- P1c: retomada de bootstrap-em-andamento (processo real) ----------
sec("P1c — crash pós-consumo: segunda execução deve retomar, não exigir nova autorização");
{
  const { raiz, env } = fixture();
  const dirEst = join(env.MESTRE_STATE_DIR, ee.instalacaoId(RAIZ));

  // 1) Gate 0 autoriza (clone limpo)
  const g1 = rodar(GATE, [], env);
  t("gate 1: autorização emitida (exit 0)", g1.code === 0, g1.saida.slice(0, 200));
  t("bootstrap-autorizacao.json existe", existsSync(join(dirEst, "bootstrap-autorizacao.json")));

  // 2) Restaurador consome + grava bootstrap-em-andamento (simula crash
  //    depois do consumo, ANTES do migrate — banco segue ausente)
  const r1 = rodar(RESTAURADOR, [], env);
  t("restaurador 1: exit 0 (nada a restaurar)", r1.code === 0, r1.saida.slice(0, 200));
  t("autorização consumida (sumiu)", !existsSync(join(dirEst, "bootstrap-autorizacao.json")));
  t("bootstrap-em-andamento.json gravado", existsSync(join(dirEst, "bootstrap-em-andamento.json")));

  // 3) Reinício: gate deve deixar prosseguir pelo marcador de andamento
  const g2 = rodar(GATE, [], env);
  t("gate 2 pós-crash: exit 0 (prossegue por bootstrap-em-andamento)", g2.code === 0, g2.saida.slice(0, 200));

  // 4) Restaurador na segunda execução NÃO pode exigir autorização nova
  const r2 = rodar(RESTAURADOR, [], env);
  t("restaurador 2: retoma sem nova autorização (exit 0)", r2.code === 0, r2.saida.slice(0, 300));

  // 5) migrate cria o banco; próximo gate adota (marcador+recibo)
  const m = rodar(MIGRADOR, [], env);
  t("migrate: exit 0", m.code === 0, m.saida.slice(0, 200));
  t("banco criado", existsSync(env.MESTRE_BANCO));
  const g3 = rodar(GATE, [], env);
  t("gate 3 pós-migrate: exit 0 (adoção)", g3.code === 0, g3.saida.slice(0, 200));
  const camMarcador = join(env.MESTRE_PROVENIENCIA_DIR, ee.instalacaoId(RAIZ), "instalacao-marcador.json");
  t("marcador de proveniência gravado", existsSync(camMarcador));
  t("recibo gravado", existsSync(join(dirEst, "instalacao-recibo.json")));
  t("bootstrap-em-andamento limpo", !existsSync(join(dirEst, "bootstrap-em-andamento.json")));
}

// ---------- P4: assumir-reinstalacao com marcador corrompido ----------
sec("P4 — assumir-reinstalacao --confirmar com marcador corrompido");
{
  const { raiz, env } = fixture();
  const camMarcador = join(env.MESTRE_PROVENIENCIA_DIR, ee.instalacaoId(RAIZ), "instalacao-marcador.json");
  mkdirSync(dirname(camMarcador), { recursive: true });
  writeFileSync(camMarcador, "{json corrompido!!!");
  const id = ee.instalacaoId(RAIZ);
  const dirEst = join(env.MESTRE_STATE_DIR, id);

  const r = rodar(GATE, ["assumir-reinstalacao", "--confirmar"], env);
  const emitiu = existsSync(join(dirEst, "bootstrap-autorizacao.json"));
  t("marcador corrompido: operação recusada ANTES de emitir autorização", !emitiu, `exit=${r.code} saida=${r.saida.slice(0, 200)}`);
  // Se emitiu mesmo assim, o boot seguinte deve bloquear — documenta incoerência
  const g = rodar(GATE, [], env);
  t("boot seguinte permanece bloqueado (marcador-corrompido)", g.code !== 0, g.saida.slice(0, 200));
}

// ---------- P5: verificarPortao somente-leitura ----------
sec("P5 — verificarPortao: alegação de 100% somente-leitura");
{
  const { raiz, env } = fixture();
  const m = rodar(MIGRADOR, [], env);
  t("setup: migrate exit 0", m.code === 0, m.saida.slice(0, 150));
  const dirEst = join(env.MESTRE_STATE_DIR, ee.instalacaoId(RAIZ));
  mkdirSync(dirEst, { recursive: true });
  // journal corrompido no state dir → lerJournal quarentena (rename!)
  writeFileSync(join(dirEst, "restauracao-externa.json"), "{lixo");
  const bancoDir = dirname(env.MESTRE_BANCO);
  const antes = new Set([
    ...readdirSync(dirEst).map((n) => join(dirEst, n)),
    ...readdirSync(bancoDir).map((n) => join(bancoDir, n)),
  ]);
  const v = await gate.verificarPortao({ repoDir: RAIZ, env });
  const depois = [
    ...readdirSync(dirEst).map((n) => join(dirEst, n)),
    ...readdirSync(bancoDir).map((n) => join(bancoDir, n)),
  ];
  const novos = depois.filter((p) => !antes.has(p));
  const sumiram = [...antes].filter((p) => !depois.includes(p));
  t("verificarPortao não cria/quarentena arquivos (read-only)", novos.length === 0 && sumiram.length === 0,
    `novos=${JSON.stringify(novos)} sumiram=${JSON.stringify(sumiram)} motivo=${v.motivo}`);
  t("sidecars -wal/-shm não criados no banco", !existsSync(env.MESTRE_BANCO + "-wal") && !existsSync(env.MESTRE_BANCO + "-shm"),
    `wal=${existsSync(env.MESTRE_BANCO + "-wal")} shm=${existsSync(env.MESTRE_BANCO + "-shm")}`);
}

console.log(`\n==== ${pass} ok, ${fail} falhas ====`);
process.exit(fail ? 1 : 0);
