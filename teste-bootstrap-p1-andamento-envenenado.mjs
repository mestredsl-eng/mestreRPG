#!/usr/bin/env node
// Regressão P1 W13/W14 — "andamento envenenado".
//
// Defeito auditado em db49214 (aplicar-restauracao.ts, autorizarBootstrap):
// o restaurador grava bootstrap-em-andamento "autorizacao-pendente"
// ANTES de consumir a autorização, incondicionalmente — inclusive sem
// autorização válida (autorizacaoId indefinido). Se o consumo falha, o
// andamento inválido permanece e avaliarBootstrapAndamento() passa a
// bloquear Gate 0, migrador, servidor e restaurador PARA SEMPRE —
// uma tentativa de bootstrap sem autorização envenena o primeiro boot
// legítimo posterior.
//
// CONTRATO DESEJADO (o que esta suíte exige):
//   1. a tentativa sem autorização DEVE bloquear (exit != 0);
//   2. ela NÃO pode deixar estado que impeça um bootstrap legítimo
//      posterior — nova autorização válida deve permitir o primeiro
//      boot completo (restaurador exit 0 + migrate exit 0);
//   3. se um andamento "pendente" for deixado, ele precisa ser
//      semanticamente consistente (autorizacaoId válido de 32 hex).
//
// Uso: node teste-bootstrap-p1-andamento-envenenado.mjs
// Requer servidor/dist compilado (npm run build -w servidor).
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const RAIZ = process.cwd();
const GATE = join(RAIZ, "scripts", "bootstrap-install.mjs");
const RESTAURADOR = join(RAIZ, "servidor", "dist", "db", "aplicar-restauracao.js");
const MIGRADOR = join(RAIZ, "servidor", "dist", "db", "migrate.js");

let pass = 0, fail = 0;
const t = (n, c, extra = "") => { if (c) { pass++; console.log("  ok", n); } else { fail++; console.log("  FALHOU", n, extra); } };
const sec = (n) => console.log("\n== " + n + " ==");

const ee = await import(pathToFileURL(join(RAIZ, "scripts", "estado-externo.mjs")).href);

let seq = 0;
function fixture() {
  const raiz = join(tmpdir(), `w14p1-${process.pid}-${seq++}`);
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
const dirEst = (env) => join(env.MESTRE_STATE_DIR, ee.instalacaoId(RAIZ));
const caminhoAndamento = (env) => join(dirEst(env), ee.ARQUIVO_BOOTSTRAP_ANDAMENTO ?? "bootstrap-em-andamento.json");
const lerAndamento = (env) => {
  const p = caminhoAndamento(env);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, "utf8")); } catch { return { __corrompido: true }; }
};
// Remove a autorização pendente (simula que ela sumiu/foi substituída).
const removerAutorizacao = (env) => rmSync(join(dirEst(env), "bootstrap-autorizacao.json"), { force: true });

/** Executa o ciclo completo de "falha → recuperação legítima".
 *  montarFalha(env) prepara o estado ANTES da 1ª tentativa do
 *  restaurador (ex.: autorização corrompida). Devolve as asserções. */
function cenario(nome, montarFalha) {
  sec(nome);
  const { env } = fixture();
  if (montarFalha) montarFalha(env);

  // 1) tentativa sem autorização válida → DEVE bloquear
  const r1 = rodar(RESTAURADOR, [], env);
  t("tentativa sem autorização bloqueia (exit != 0)", r1.code !== 0, `exit=${r1.code}`);

  // 2) diagnóstico do andamento deixado
  const and = lerAndamento(env);
  if (and) {
    const idOk = typeof and.autorizacaoId === "string" && /^[0-9a-f]{32}$/.test(and.autorizacaoId);
    t("andamento deixado é semanticamente consistente (autorizacaoId 32-hex)",
      idOk, `etapa=${and.etapa} autorizacaoId=${and.autorizacaoId}`);
  } else {
    t("sem andamento residual (diagnóstico)", true, "arquivo ausente");
  }

  // 3) autorização legítima nova → bootstrap deve completar
  ee.gravarAutorizacaoBootstrap(RAIZ, env);
  const r2 = rodar(RESTAURADOR, [], env);
  t("restaurador com autorização legítima → exit 0", r2.code === 0,
    `exit=${r2.code} ${r2.saida.slice(0, 250)}`);
  const r3 = rodar(MIGRADOR, [], env);
  t("migrate após bootstrap → exit 0", r3.code === 0,
    `exit=${r3.code} ${(r3.saida || "").slice(0, 250)}`);
  // 4) gate não pode estar travado em estado inválido
  const g = rodar(GATE, [], env);
  t("Gate 0 não bloqueia instalação concluída", g.code === 0, `exit=${g.code} ${g.saida.slice(0, 200)}`);
}

// A) nenhuma autorização — tentativa mais simples de envenenamento
cenario("A — restaurador sem nenhuma autorização");

// B) autorização corrompida (JSON inválido)
cenario("B — autorização corrompida", (env) => {
  const de = dirEst(env);
  mkdirSync(de, { recursive: true });
  writeFileSync(join(de, "bootstrap-autorizacao.json"), "{quebrado");
});

// C) autorização divergente (instalacaoId de outra instalação)
cenario("C — autorização divergente", (env) => {
  const de = dirEst(env);
  mkdirSync(de, { recursive: true });
  writeFileSync(join(de, "bootstrap-autorizacao.json"), JSON.stringify({
    protocoloVersao: 1, instalacaoId: "f".repeat(64),
    repoCanon: "C:\\outra\\instalacao", tipo: "bootstrap-autorizacao",
    emitidaEm: new Date().toISOString(), autorizacaoId: "a".repeat(32),
  }));
});

// D) somente consumida de ciclo antigo (sem autorização pendente)
cenario("D — apenas consumida de ciclo antigo", (env) => {
  ee.gravarAutorizacaoBootstrap(RAIZ, env, { emitidaEm: "2020-01-01T00:00:00Z", origem: "ciclo-antigo" });
  const c = ee.consumirAutorizacaoBootstrap(RAIZ, env);
  if (!c.autorizado) console.log("  (aviso: setup D não consumiu:", c.motivo, ")");
});

// E) crash real após "pendente" + autorização removida depois
{
  sec("E — crash após pendente, autorização some, ciclo novo deve recuperar");
  const { env } = fixture();
  // ciclo 1: autorização X válida → crash no ponto "pendente" (exit 42)
  ee.gravarAutorizacaoBootstrap(RAIZ, env);
  const rCrash = rodar(RESTAURADOR, [], { ...env, NODE_ENV: "test", MESTRE_BOOTSTRAP_CRASH_AFTER: "pendente" });
  t("setup: crash real no pendente (exit 42)", rCrash.code === 42, `exit=${rCrash.code}`);
  // autorização X desaparece; ciclo 2 emite autorização Y
  removerAutorizacao(env);
  const rFalha = rodar(RESTAURADOR, [], env);
  t("retomada sem a autorização do ciclo → bloqueia", rFalha.code !== 0, `exit=${rFalha.code}`);
  ee.gravarAutorizacaoBootstrap(RAIZ, env);
  const r2 = rodar(RESTAURADOR, [], env);
  t("novo ciclo legítimo recupera → exit 0", r2.code === 0,
    `exit=${r2.code} ${r2.saida.slice(0, 250)}`);
  const r3 = rodar(MIGRADOR, [], env);
  t("migrate após recuperação → exit 0", r3.code === 0, `exit=${r3.code}`);
}

// F) controle positivo: fixture limpa + autorização → boot completo
{
  sec("F — controle: primeiro bootstrap legítimo direto");
  const { env } = fixture();
  ee.gravarAutorizacaoBootstrap(RAIZ, env);
  const r1 = rodar(RESTAURADOR, [], env);
  t("restaurador exit 0", r1.code === 0, `exit=${r1.code} ${r1.saida.slice(0, 200)}`);
  const r2 = rodar(MIGRADOR, [], env);
  t("migrate exit 0", r2.code === 0, `exit=${r2.code}`);
}

console.log(`\n==== ${pass} ok, ${fail} falhas ====`);
process.exit(fail ? 1 : 0);
