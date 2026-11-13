#!/usr/bin/env node
// Concorrência do endpoint POST /characters/:id/pontos (bônus individual).
// Garante que concessões/remoções simultâneas e corrida com PATCH genérico
// não perdem saldo nem eventos de histórico — estado persistido final é a prova.
import { req, dirTeste, prepararBanco, portaLivre, subirServidor, esperarSaudavel, encerrarServidor, limparDir, criarCenario, sessao, abrirDb } from "./teste-base.mjs";
import crypto from "node:crypto";

const DIR = dirTeste("pontos");
const BANCO = join(DIR, "mestre-rpg.db");
const ARQ = join(DIR, "arquivos");
const BKS = join(DIR, "backups");
const PORTA = await portaLivre();
const BASE = `http://localhost:${PORTA}`;
let proc;
let pass = 0, fail = 0;

import { join } from "path";
import { mkdirSync, existsSync, writeFileSync, rmSync } from "fs";

function t(desc, ok, details = "") {
  if (ok) {
    console.log(`  ok ${desc}`);
    pass++;
  } else {
    console.log(`  FALHOU ${desc} ${details}`);
    fail++;
  }
}

// Espera determinística por arquivo-sinal (barreira do gate TOCTOU).
async function esperarArquivo(caminho, timeoutMs = 8000) {
  const limite = Date.now() + timeoutMs;
  while (Date.now() < limite) {
    if (existsSync(caminho)) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return false;
}

async function fichaDe(fichaId, cookie) {
  const r = await req(BASE, "GET", `/characters/${fichaId}`, { cookie });
  return r.json;
}

async function pontosDe(fichaId, cookie) {
  const j = await fichaDe(fichaId, cookie);
  return j?.ficha?.pontosBonus ?? null;
}

try {
  await prepararBanco(BANCO);
  mkdirSync(ARQ, { recursive: true });
  mkdirSync(BKS, { recursive: true });

  // Barreira determinística de teste (TOCTOU): o endpoint só ativa o gate
  // com TRÊS condições — NODE_ENV=test, MESTRE_PONTOS_GATE_DIR definido e
  // arquivo "armar" presente. O servidor filho é iniciado explicitamente
  // em modo de teste, sem depender do ambiente do terminal.
  const GATE = join(DIR, "gate");
  mkdirSync(GATE, { recursive: true });
  process.env.MESTRE_PONTOS_GATE_DIR = GATE;
  process.env.NODE_ENV = "test";
  proc = subirServidor(PORTA, { banco: BANCO, arquivos: ARQ, backups: BKS });
  proc.stderr.on("data", (d) => process.stderr.write(d));
  proc.stdout.on("data", (d) => process.stdout.write(d));
  proc.on("exit", (code) => console.log(`  [servidor saiu code=${code}]`));
  await esperarSaudavel(BASE, proc);

  const c = await criarCenario(BASE, BANCO, { jogadores: { jogador1: "jog_pontos" } });
  const cm = c.cookieMestre;
  const cj = c.jogadores.jogador1.cookie;
  const ficha = c.personagemMestre;

  // ===== 1. jogador não pode conceder pontos =====
  const semPermissao = await req(BASE, "POST", `/characters/${ficha}/pontos`, {
    cookie: cj, body: { acao: "conceder", quantidade: 5, motivo: "tentativa" },
  });
  t("jogador não pode conceder pontos", semPermissao.status === 403, `status=${semPermissao.status}`);

  // ===== 2. duas concessões simultâneas de +5 → saldo +10, 2 eventos =====
  const [r1, r2] = await Promise.all([
    req(BASE, "POST", `/characters/${ficha}/pontos`, {
      cookie: cm, body: { acao: "conceder", quantidade: 5, motivo: "concessão 1" },
    }),
    req(BASE, "POST", `/characters/${ficha}/pontos`, {
      cookie: cm, body: { acao: "conceder", quantidade: 5, motivo: "concessão 2" },
    }),
  ]);
  t("duas concessões simultâneas → 200 ambas", r1.status === 200 && r2.status === 200, `r1=${r1.status} r2=${r2.status}`);
  const p1 = await pontosDe(ficha, cm);
  t("saldo final = +10", p1?.bonus === 10, `bonus=${p1?.bonus}`);
  t("histórico tem 2 eventos", p1?.historico?.length === 2, `n=${p1?.historico?.length}`);
  const motivos = (p1?.historico ?? []).map((h) => h.motivo).sort();
  t("ambos motivos presentes", motivos[0] === "concessão 1" && motivos[1] === "concessão 2", JSON.stringify(motivos));

  // ===== 3. duas remoções simultâneas =====
  const [r3, r4] = await Promise.all([
    req(BASE, "POST", `/characters/${ficha}/pontos`, {
      cookie: cm, body: { acao: "remover", quantidade: 3, motivo: "remoção 1" },
    }),
    req(BASE, "POST", `/characters/${ficha}/pontos`, {
      cookie: cm, body: { acao: "remover", quantidade: 2, motivo: "remoção 2" },
    }),
  ]);
  t("duas remoções simultâneas → 200 ambas", r3.status === 200 && r4.status === 200, `r3=${r3.status} r4=${r4.status}`);
  const p2 = await pontosDe(ficha, cm);
  t("saldo final = 10 - 5 = 5", p2?.bonus === 5, `bonus=${p2?.bonus}`);
  t("histórico tem 4 eventos", p2?.historico?.length === 4, `n=${p2?.historico?.length}`);

  // ===== 4. corrida entre concessão de pontos e PATCH genérico =====
  // O PATCH valida contra snapshot e responde 409 se a ficha mudou no meio
  // do caminho — nunca sobrescreve silenciosamente. O /pontos relê dentro
  // da transação e sempre aplica sobre o estado atual. Os dois desfechos
  // válidos: (a) PATCH 200 e concessão preservada; (b) PATCH 409 e a
  // concessão permanece gravada. O que não pode acontecer é perda muda.
  const [r5, r6] = await Promise.all([
    req(BASE, "POST", `/characters/${ficha}/pontos`, {
      cookie: cm, body: { acao: "conceder", quantidade: 10, motivo: "corrida pontos" },
    }),
    req(BASE, "PATCH", `/characters/${ficha}`, {
      cookie: cm, body: { name: "Herói Atualizado", data: { for: 9 } },
    }),
  ]);
  t("concessão responde 200", r5.status === 200, `status=${r5.status}`);
  t("PATCH responde 200 ou 409 (nunca sobrescreve muda)", r6.status === 200 || r6.status === 409, `status=${r6.status}`);
  const fichaDepois = await fichaDe(ficha, cm);
  const fjson = fichaDepois?.personagem;
  const p3 = fichaDepois?.ficha?.pontosBonus;
  t("bônus concedido preservado (bonus=15)", p3?.bonus === 15, `bonus=${p3?.bonus} patch=${r6.status}`);
  t("histórico tem 5 eventos", p3?.historico?.length === 5, `n=${p3?.historico?.length}`);
  if (r6.status === 200) {
    t("PATCH aplicado (nome e dados)", fjson?.name === "Herói Atualizado" && fichaDepois?.ficha?.campos?.for === 9, `name=${fjson?.name}`);
  } else {
    t("PATCH rejeitado sem efeito colateral", fjson?.name !== "Herói Atualizado", `name=${fjson?.name}`);
  }

  // ===== 5. falha não deixa histórico parcial =====
  const semMotivo = await req(BASE, "POST", `/characters/${ficha}/pontos`, {
    cookie: cm, body: { acao: "conceder", quantidade: 5, motivo: "" },
  });
  t("sem motivo → 400", semMotivo.status === 400, `status=${semMotivo.status}`);
  const p4 = await pontosDe(ficha, cm);
  t("histórico inalterado após falha", p4?.historico?.length === 5, `n=${p4?.historico?.length}`);
  t("saldo inalterado após falha", p4?.bonus === 15, `bonus=${p4?.bonus}`);

  // ===== 6. TOCTOU: mestre rebaixado entre autorização e mutação =====
  // Barreira determinística: o endpoint sinaliza "chegou" (já passou pela
  // autorização inicial, imediatamente antes da transação) e só prossegue
  // quando o teste grava "liberar". Sem sleep: a sincronia é por arquivo.
  const uidM2 = crypto.randomUUID();
  const agoraMs = Date.now();
  {
    const db = abrirDb(BANCO);
    try {
      db.prepare("insert into users (id,username,display_name,password_hash,is_admin,status,created_at,updated_at) values (?,?,?,?,0,'ativo',?,?)")
        .run(uidM2, "mestre_rebaixado", "Mestre Rebaixado", "x", agoraMs, agoraMs);
      db.prepare("insert into memberships (id,campaign_id,user_id,role,status,joined_at,created_at,updated_at) values (?,?,?,'mestre','ativo',?,?,?)")
        .run(crypto.randomUUID(), c.campId, uidM2, agoraMs, agoraMs, agoraMs);
    } finally { db.close(); }
  }
  const cm2 = sessao(BANCO, uidM2);
  const pAntes = await pontosDe(ficha, cm);
  // arma o gate: só a próxima requisição a /pontos ficará na barreira
  writeFileSync(join(GATE, "armar"), "1");
  const reqRevogada = req(BASE, "POST", `/characters/${ficha}/pontos`, {
    cookie: cm2, headers: { connection: "close" },
    body: { acao: "conceder", quantidade: 7, motivo: "tentativa rebaixado" },
  });
  // barreira determinística: espera o endpoint sinalizar que chegou ao
  // ponto imediatamente anterior à transação (autorização inicial já passou)
  const chegou = await esperarArquivo(join(GATE, "chegou"), 8000);
  t("requisição alcançou a barreira pós-autorização", chegou);
  {
    const dbw = abrirDb(BANCO);
    try {
      dbw.prepare("update memberships set role='jogador' where campaign_id=? and user_id=?").run(c.campId, uidM2);
    } finally { dbw.close(); }
  }
  writeFileSync(join(GATE, "liberar"), "1");
  const r7 = await reqRevogada;
  rmSync(join(GATE, "armar"), { force: true }); // desarma: próximas chamadas não passam pela barreira
  t("mestre rebaixado durante a requisição → 403", r7.status === 403, `status=${r7.status}`);
  const pDepois = await pontosDe(ficha, cm);
  t("saldo inalterado após revogação", pDepois?.bonus === pAntes?.bonus, `antes=${pAntes?.bonus} depois=${pDepois?.bonus}`);
  t("histórico inalterado após revogação", pDepois?.historico?.length === pAntes?.historico?.length, `antes=${pAntes?.historico?.length} depois=${pDepois?.historico?.length}`);

  // mestre ativo continua funcionando após o episódio
  const r8 = await req(BASE, "POST", `/characters/${ficha}/pontos`, {
    cookie: cm, body: { acao: "conceder", quantidade: 2, motivo: "pós-revogação" },
  });
  const pFinal = await pontosDe(ficha, cm);
  t("mestre ativo segue operando normalmente", r8.status === 200 && pFinal?.bonus === (pAntes?.bonus ?? 0) + 2, `status=${r8.status} bonus=${pFinal?.bonus}`);

  // ===== 7. Gate inerte sem modo de teste (negativo de produção) =====
  // Segundo servidor SEM NODE_ENV=test, mas com GATE_DIR e "armar"
  // presentes: a requisição não pode esperar por "liberar" — prova de
  // comportamento, não só de variável. A trava de instância exige UM
  // servidor por banco: encerramos o primeiro antes de subir o segundo
  // (a sessão cm vive no banco, segue válida).
  await encerrarServidor(proc);
  const GATE2 = join(DIR, "gate2");
  mkdirSync(GATE2, { recursive: true });
  writeFileSync(join(GATE2, "armar"), "1"); // propositalmente SEM "liberar"
  process.env.MESTRE_PONTOS_GATE_DIR = GATE2;
  delete process.env.NODE_ENV; // servidor filho nasce sem modo de teste
  const PORTA2 = await portaLivre();
  const BASE2 = `http://localhost:${PORTA2}`;
  const proc2 = subirServidor(PORTA2, { banco: BANCO, arquivos: ARQ, backups: BKS });
  process.env.NODE_ENV = "test"; // restaura para o restante do teste
  await esperarSaudavel(BASE2, proc2);
  const t0 = Date.now();
  const rGate = await req(BASE2, "POST", `/characters/${ficha}/pontos`, {
    cookie: cm, body: { acao: "conceder", quantidade: 1, motivo: "gate inativo" },
  });
  const dtGate = Date.now() - t0;
  await encerrarServidor(proc2);
  t("sem NODE_ENV=test o gate é ignorado (não espera 'liberar')",
    rGate.status === 200 && dtGate < 3000 && !existsSync(join(GATE2, "chegou")),
    `status=${rGate.status} ms=${dtGate} chegou=${existsSync(join(GATE2, "chegou"))}`);

} finally {
  await encerrarServidor(proc);
  limparDir(DIR);
}

console.log(`\n==== ${pass} ok, ${fail} falhas ====`);
process.exit(fail ? 1 : 0);
