// Issue #186 R6.1 — transação atômica do `mesa:teste:rolar`.
// Cobre: caminho feliz, concorrência (1 roll), retry idempotente,
// rollback determinístico via trigger SQLite, regras alteradas entre
// pré-carga e commit (MESTRE_PAUSA_FLAG), autorização/visibilidade,
// vitalidade e D10 server-side. Banco 100% descartável.
import crypto from "node:crypto";
import { writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { io as ioClient } from "socket.io-client";
import {
  dirTeste, prepararBanco, portaLivre, subirServidor, esperarSaudavel,
  criarCenario, req, abrirDb, encerrarServidor, limparDir,
} from "./teste-base.mjs";

let pass = 0, fail = 0;
const t = (n, c, extra = "") => { if (c) { pass++; console.log("  ok", n); } else { fail++; console.log("  FALHOU", n, extra); } };
const sec = (n) => console.log("\n== " + n + " ==");
const sono = (ms) => new Promise((r) => setTimeout(r, ms));

const DIR = dirTeste("d10-transacao");
const BANCO = join(DIR, "banco.db");
const FLAG = join(DIR, "pausa.flag");
const PORTA = await portaLivre();
const BASE = `http://localhost:${PORTA}`;
let proc;
let sockM, sockJ, sockJ2, sockJb;

const emitir = (sock, ev, payload) => new Promise((res) => sock.emit(ev, payload, res));
const contarRolls = (campId) =>
  abrirDb(BANCO).prepare("select count(*) n from rolls where campaign_id=?").get(campId).n;
const testeRow = (id) => abrirDb(BANCO).prepare("select * from tests where id=?").get(id);

function conectar(cookie) {
  const s = ioClient(BASE, { extraHeaders: { cookie }, transports: ["websocket"] });
  return new Promise((res) => s.on("connect", () => res(s)));
}
function novoTeste(c, { sessionId, characterId, userId, visibility = "publica", dados = 4, lados = 10, alvo = null }) {
  const db = abrirDb(BANCO);
  try {
    const id = crypto.randomUUID(), agora = Date.now();
    db.prepare(`insert into tests (id,campaign_id,session_id,character_id,requested_by,skill_ref,modifiers,dice_count,dice_sides,target,status,visibility,request_id,created_at,updated_at)
      values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, c.campId, sessionId, characterId, userId, null, "{}", dados, lados, alvo, "pendente", visibility, null, agora, agora);
    return id;
  } finally { db.close(); }
}

try {
  await prepararBanco(BANCO);
  proc = subirServidor(PORTA, {
    banco: BANCO, arquivos: join(DIR, "arq"), backups: join(DIR, "bkp"),
    env: { MESTRE_PAUSA_FLAG: FLAG },
  });
  proc.stderr?.on("data", (d) => console.log("[srv-err]", String(d)));
  proc.stdout?.on("data", (d) => { const s = String(d); if (/erro|error|fail/i.test(s)) console.log("[srv-out]", s.slice(0, 300)); });
  await esperarSaudavel(BASE, proc);

  const c = await criarCenario(BASE, BANCO, {
    campanha: "Campanha D10 Transação",
    config: {
      dados: { d10SucessoMinimo: 8 },
      vitalidade: { niveis: [
        { nome: "Normal", penalidadeDados: 0, bloqueiaAcoes: false },
        { nome: "Ferido", penalidadeDados: 2, bloqueiaAcoes: false },
        { nome: "Incapacitado", penalidadeDados: 4, bloqueiaAcoes: true },
      ] },
    },
  });
  const charNormal = c.novoPersonagem(c.jogadores.jogador1.membershipId, "Herói Normal");
  const charFerido = c.novoPersonagem(c.jogadores.jogador1.membershipId, "Herói Ferido", { __vitalidade: { nivel: 1 } });
  const charIncapaz = c.novoPersonagem(c.jogadores.jogador1.membershipId, "Herói Incapaz", { __vitalidade: { nivel: 2 } });

  const sess = await req(BASE, "POST", `/campaigns/${c.campId}/sessoes`, { cookie: c.cookieMestre, body: { name: "Mesa Tx" } });
  const SID = sess.json?.sessao?.id;
  t("sessão criada", !!SID, JSON.stringify(sess.json).slice(0, 120));

  sockM = await conectar(c.cookieMestre);
  sockJ = await conectar(c.jogadores.jogador1.cookie);
  sockJ2 = await conectar(c.jogadores.jogador2.cookie);
  sockJb = await conectar(c.jogadores.jogador1.cookie); // 2ª aba do dono
  await Promise.all([
    emitir(sockM, "mesa:entrar", { sessionId: SID }),
    emitir(sockJ, "mesa:entrar", { sessionId: SID }),
    emitir(sockJ2, "mesa:entrar", { sessionId: SID }),
    emitir(sockJb, "mesa:entrar", { sessionId: SID }),
  ]);
  const rolagsM = [], rolagsJ = [];
  sockM.on("mesa:rolagem", (p) => rolagsM.push(p));
  sockJ.on("mesa:rolagem", (p) => rolagsJ.push(p));

  sec("1. Caminho normal — roll persistido, status, ACK e evento");
  {
    const tid = novoTeste(c, { sessionId: SID, characterId: charNormal, userId: c.jogadores.jogador1.id, dados: 4, lados: 10, alvo: 15 });
    const antes = contarRolls(c.campId);
    const r = await emitir(sockJ, "mesa:teste:rolar", { testId: tid, requestId: "tx-" + crypto.randomUUID().slice(0, 8) });
    t("ACK ok com dados", r?.ok === true && Array.isArray(r?.dados) && r.dados.length === 4, JSON.stringify(r).slice(0, 200));
    const row = testeRow(tid);
    t("tests.status=rolado + roll_id", row?.status === "rolado" && !!row?.roll_id, JSON.stringify({ s: row?.status, r: row?.roll_id }));
    t("1 roll persistido", contarRolls(c.campId) === antes + 1);
    t("d10 server-side mínimo=8", r?.d10?.minimo === 8, JSON.stringify(r?.d10));
    await sono(300);
    // visibilidade "publica": mestre recebe sala (sem alvo) + privado (com alvo)
    const evsM = rolagsM.filter((p) => p.testId === tid);
    t("mesa:rolagem emitida p/ mestre", evsM.length >= 1, `n=${evsM.length}`);
    t("mestre recebe alvo no privado", evsM.some((p) => p.alvo === 15));
    t("dono recebe SEM alvo", rolagsJ.filter((p) => p.testId === tid).every((p) => !("alvo" in p)),
      JSON.stringify(rolagsJ.filter((p) => p.testId === tid).map((p) => Object.keys(p))));
  }

  sec("2-3. Concorrência e retry — exatamente um roll");
  {
    const tid = novoTeste(c, { sessionId: SID, characterId: charNormal, userId: c.jogadores.jogador1.id, dados: 3, lados: 10 });
    const antes = contarRolls(c.campId);
    const [r1, r2] = await Promise.all([
      emitir(sockJ, "mesa:teste:rolar", { testId: tid }),
      emitir(sockJb, "mesa:teste:rolar", { testId: tid }),
    ]);
    const umRoll = (r1?.dados && (r2?.jaRolado || r2?.duplicado)) || (r2?.dados && (r1?.jaRolado || r1?.duplicado));
    t("dois sockets → um roll + um idempotente", umRoll === true, `r1=${JSON.stringify(r1)?.slice(0, 120)} r2=${JSON.stringify(r2)?.slice(0, 120)}`);
    t("exatamente 1 roll novo", contarRolls(c.campId) === antes + 1, `antes=${antes} depois=${contarRolls(c.campId)}`);
    // retry sequencial pós-commit
    const r3 = await emitir(sockJ, "mesa:teste:rolar", { testId: tid });
    t("retry pós-commit → jaRolado", r3?.ok === true && r3?.jaRolado === true, JSON.stringify(r3));
    t("retry não cria roll", contarRolls(c.campId) === antes + 1);
  }

  sec("4. Rollback determinístico — falha entre insert e update");
  {
    const tid = novoTeste(c, { sessionId: SID, characterId: charNormal, userId: c.jogadores.jogador1.id, dados: 2, lados: 10 });
    const antes = contarRolls(c.campId);
    const db = abrirDb(BANCO);
    db.exec(`CREATE TRIGGER trg_fail_test_update BEFORE UPDATE ON tests
      WHEN NEW.status='rolado' BEGIN SELECT RAISE(ABORT,'falha simulada tx'); END`);
    db.close();
    const r = await emitir(sockJ, "mesa:teste:rolar", { testId: tid });
    const row = testeRow(tid);
    const dbq = abrirDb(BANCO);
    dbq.exec("DROP TRIGGER IF EXISTS trg_fail_test_update");
    dbq.close();
    t("ACK erro (sem resposta pendente)", r?.ok === false, JSON.stringify(r));
    t("rollback: zero roll novo", contarRolls(c.campId) === antes, `antes=${antes} depois=${contarRolls(c.campId)}`);
    t("teste continua pendente", row?.status === "pendente" && !row?.rollId, JSON.stringify({ s: row?.status, r: row?.rollId }));
    // após remover o trigger, o mesmo teste rola normalmente
    const r2 = await emitir(sockJ, "mesa:teste:rolar", { testId: tid });
    t("retry pós-rollback rola ok", r2?.ok === true && r2?.jaRolado !== true, JSON.stringify(r2).slice(0, 120));
    t("roll persistido após retry", contarRolls(c.campId) === antes + 1);
  }

  sec("5. Regras alteradas entre pré-carga e commit → aborta");
  {
    const tid = novoTeste(c, { sessionId: SID, characterId: charNormal, userId: c.jogadores.jogador1.id, dados: 4, lados: 10 });
    const antes = contarRolls(c.campId);
    writeFileSync(FLAG, tid); // pausa o handler DEPOIS da pré-carga (fingerprint já lido)
    const pendente = emitir(sockJ, "mesa:teste:rolar", { testId: tid });
    // espera o handler pausar
    for (let i = 0; i < 100 && !existsSync(FLAG + ".pausado"); i++) await sono(50);
    t("handler pausado na barreira de teste", existsSync(FLAG + ".pausado"));
    const put = await req(BASE, "PUT", `/campaigns/${c.campId}/regras/config`, {
      cookie: c.cookieMestre, body: { dados: { d10SucessoMinimo: 9 } },
    });
    t("regras alteradas durante a pausa", put.status === 200, `status=${put.status}`);
    rmSync(FLAG);
    const r = await pendente;
    t("ACK rejeita regra obsoleta", r?.ok === false && /alteradas/i.test(r?.erro ?? ""), JSON.stringify(r));
    t("sem roll gravado", contarRolls(c.campId) === antes);
    t("teste segue pendente", testeRow(tid)?.status === "pendente");
    rmSync(FLAG + ".pausado", { force: true });
  }

  sec("6. Autorização — outra campanha, arquivado, não-dono, espectador");
  {
    // personagem arquivado
    const charArq = c.novoPersonagem(c.jogadores.jogador1.membershipId, "Herói Arquivado");
    {
      const db = abrirDb(BANCO);
      db.prepare("update characters set status='arquivado' where id=?").run(charArq);
      db.close();
    }
    const tidArq = novoTeste(c, { sessionId: SID, characterId: charArq, userId: c.jogadores.jogador1.id });
    const antes = contarRolls(c.campId);
    const rArq = await emitir(sockJ, "mesa:teste:rolar", { testId: tidArq });
    t("personagem arquivado → rejeitado", rArq?.ok === false, JSON.stringify(rArq));
    t("arquivado não gravou", contarRolls(c.campId) === antes && testeRow(tidArq)?.status === "pendente");

    // jogador2 não é dono do personagem de jogador1
    const tidDono = novoTeste(c, { sessionId: SID, characterId: charNormal, userId: c.jogadores.jogador1.id });
    const rDono = await emitir(sockJ2, "mesa:teste:rolar", { testId: tidDono });
    t("não-dono → rejeitado", rDono?.ok === false && /dono|mestre/i.test(rDono?.erro ?? ""), JSON.stringify(rDono));
    t("não-dono não gravou", testeRow(tidDono)?.status === "pendente");

    // espectador: rebaixa membership de jogador2 temporariamente
    {
      const db = abrirDb(BANCO);
      db.prepare("update memberships set role='espectador' where id=?").run(c.jogadores.jogador2.membershipId);
      db.close();
    }
    const tidEsp = novoTeste(c, { sessionId: SID, characterId: charNormal, userId: c.jogadores.jogador1.id });
    const rEsp = await emitir(sockJ2, "mesa:teste:rolar", { testId: tidEsp });
    t("espectador → rejeitado", rEsp?.ok === false, JSON.stringify(rEsp));
    {
      const db = abrirDb(BANCO);
      db.prepare("update memberships set role='jogador' where id=?").run(c.jogadores.jogador2.membershipId);
      db.close();
    }

    // teste de OUTRA campanha: socket de jogador não é membro
    const camp2 = await req(BASE, "POST", "/campaigns", { cookie: c.cookieMestre, body: { name: "Outra Campanha" } });
    const cid2 = camp2.json?.campanha?.id;
    const db2 = abrirDb(BANCO); const agora2 = Date.now();
    const sess2 = crypto.randomUUID();
    db2.prepare("insert into sessions (id,campaign_id,number,name,status,created_at,updated_at) values (?,?,?,?,?,?,?)")
      .run(sess2, cid2, 1, "Mesa B", "ativa", agora2, agora2);
    const tidB = crypto.randomUUID();
    db2.prepare(`insert into tests (id,campaign_id,session_id,character_id,requested_by,skill_ref,modifiers,dice_count,dice_sides,target,status,visibility,request_id,created_at,updated_at)
      values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(tidB, cid2, sess2, charNormal, c.jogadores.jogador1.id, null, "{}", 4, 10, null, "pendente", "publica", null, agora2, agora2);
    db2.close();
    const antes2 = contarRolls(cid2);
    const rB = await emitir(sockJ, "mesa:teste:rolar", { testId: tidB });
    t("teste de outra campanha → rejeitado", rB?.ok === false, JSON.stringify(rB));
    t("outra campanha não gravou", contarRolls(cid2) === antes2 && testeRow(tidB)?.status === "pendente");
  }

  sec("7. Visibilidade mestre — dono não rola, mestre rola com alvo");
  {
    const tidM = novoTeste(c, { sessionId: SID, characterId: charNormal, userId: c.jogadores.jogador1.id, visibility: "mestre", alvo: 20 });
    const rDono = await emitir(sockJ, "mesa:teste:rolar", { testId: tidM });
    t("dono em teste 'mestre' → rejeitado", rDono?.ok === false && /mestre/i.test(rDono?.erro ?? ""), JSON.stringify(rDono));
    const rM = await emitir(sockM, "mesa:teste:rolar", { testId: tidM });
    t("mestre rola teste 'mestre'", rM?.ok === true, JSON.stringify(rM).slice(0, 150));
    await sono(300);
    const evsM2 = rolagsM.filter((p) => p.testId === tidM);
    t("payload mestre tem alvo", evsM2.some((p) => p.alvo === 20), JSON.stringify(evsM2.map((p) => p.alvo)));
    t("teste 'mestre' não vazou p/ sala", !rolagsJ.some((p) => p.testId === tidM));
  }

  sec("8. requestId — identidade por teste, nunca roll de outro teste");
  {
    const reqId = "req-compartilhado-" + crypto.randomUUID().slice(0, 8);
    const tidA = novoTeste(c, { sessionId: SID, characterId: charNormal, userId: c.jogadores.jogador1.id, dados: 2, lados: 10 });
    const tidB = novoTeste(c, { sessionId: SID, characterId: charNormal, userId: c.jogadores.jogador1.id, dados: 3, lados: 10 });
    const antes = contarRolls(c.campId);
    // mesmo requestId em DOIS testId diferentes → operações independentes
    const [rA, rB] = await Promise.all([
      emitir(sockJ, "mesa:teste:rolar", { testId: tidA, requestId: reqId }),
      emitir(sockJb, "mesa:teste:rolar", { testId: tidB, requestId: reqId }),
    ]);
    t("mesmo requestId, testId diferentes → ambos rolam", rA?.ok === true && rB?.ok === true && rA?.dados && rB?.dados,
      `rA=${JSON.stringify(rA)?.slice(0, 100)} rB=${JSON.stringify(rB)?.slice(0, 100)}`);
    t("rolls distintos (ids diferentes)", rA?.id && rB?.id && rA.id !== rB.id, `${rA?.id} vs ${rB?.id}`);
    t("2 rolls persistidos", contarRolls(c.campId) === antes + 2, `antes=${antes} depois=${contarRolls(c.campId)}`);
    const rowA = testeRow(tidA), rowB = testeRow(tidB);
    t("ambos testes rolados com rollIds distintos", rowA?.status === "rolado" && rowB?.status === "rolado" && rowA.roll_id !== rowB.roll_id);
    // requestId persistido é composto por teste — nunca o valor cru do cliente
    const rollsReq = abrirDb(BANCO).prepare("select request_id, reason from rolls where campaign_id=? and request_id is not null order by created_at desc limit 2").all(c.campId);
    t("request_id persistido é chave composta do teste", rollsReq.every((r) => r.request_id.startsWith("teste:")), JSON.stringify(rollsReq));
    // retry do MESMO teste com mesmo requestId → jaRolado, sem novo roll
    // (aguarda refill do bucket testeRolar — cota é por usuário)
    await sono(1200);
    const rRetry = await emitir(sockJ, "mesa:teste:rolar", { testId: tidA, requestId: reqId });
    t("retry mesmo teste+requestId → jaRolado", rRetry?.ok === true && rRetry?.jaRolado === true, JSON.stringify(rRetry));
    t("retry não cria roll", contarRolls(c.campId) === antes + 2);
    // terceiro teste com o MESMO requestId compartilhado → operação
    // independente (a chave persistida é composta por testId)
    await sono(1200);
    const tidC = novoTeste(c, { sessionId: SID, characterId: charNormal, userId: c.jogadores.jogador1.id, dados: 2, lados: 10 });
    const rC = await emitir(sockJ, "mesa:teste:rolar", { testId: tidC, requestId: reqId });
    t("mesmo requestId em 3º testId → rola independente", rC?.ok === true && rC?.dados && rC?.jaRolado !== true, JSON.stringify(rC).slice(0, 120));
    t("roll do 3º teste é novo (não reutiliza A nem B)", rC?.id && rC.id !== rA?.id && rC.id !== rB?.id);
  }

  sec("9. Sessão encerrada entre pré-carga e commit → aborta");
  {
    const tid = novoTeste(c, { sessionId: SID, characterId: charNormal, userId: c.jogadores.jogador1.id, dados: 2, lados: 10 });
    const antes = contarRolls(c.campId);
    await sono(1200); // refill do bucket testeRolar
    writeFileSync(FLAG, tid);
    const pendente = emitir(sockJ, "mesa:teste:rolar", { testId: tid });
    for (let i = 0; i < 100 && !existsSync(FLAG + ".pausado"); i++) await sono(50);
    // encerra a sessão durante a pausa
    const dbE = abrirDb(BANCO);
    dbE.prepare("update sessions set status='encerrada' where id=?").run(SID);
    dbE.close();
    rmSync(FLAG);
    const r = await pendente;
    t("ACK rejeita sessão encerrada", r?.ok === false, JSON.stringify(r));
    t("sem roll gravado", contarRolls(c.campId) === antes);
    t("teste segue pendente", testeRow(tid)?.status === "pendente");
    rmSync(FLAG + ".pausado", { force: true });
    // reabre a sessão para não afetar nada depois
    const dbR = abrirDb(BANCO);
    dbR.prepare("update sessions set status='ativa' where id=?").run(SID);
    dbR.close();
  }

  sec("10. Vitalidade — penalidade server-side e bloqueio");
  {
    const tidF = novoTeste(c, { sessionId: SID, characterId: charFerido, userId: c.jogadores.jogador1.id, dados: 4, lados: 10 });
    const rF = await emitir(sockJ, "mesa:teste:rolar", { testId: tidF });
    t("penalidade −2 aplicada (4→2 dados)", rF?.ok === true && rF?.count === 2 && rF?.vitalidade?.penalidadeDados === 2, JSON.stringify(rF).slice(0, 200));
    const tidI = novoTeste(c, { sessionId: SID, characterId: charIncapaz, userId: c.jogadores.jogador1.id, dados: 4, lados: 10 });
    const rI = await emitir(sockJ, "mesa:teste:rolar", { testId: tidI });
    t("incapacitado bloqueia jogador", rI?.ok === false && /bloqueada/i.test(rI?.erro ?? ""), JSON.stringify(rI));
    t("incapacitado segue pendente", testeRow(tidI)?.status === "pendente");
    const rIM = await emitir(sockM, "mesa:teste:rolar", { testId: tidI });
    t("mestre rola com exceção", rIM?.ok === true && rIM?.vitalidade?.excecaoMestre === true, JSON.stringify(rIM).slice(0, 200));
  }
} catch (e) {
  fail++;
  console.log("  FALHOU exceção:", String(e?.stack ?? e).slice(0, 600));
} finally {
  for (const s of [sockM, sockJ, sockJ2, sockJb].filter(Boolean)) { try { s.disconnect(); } catch {} }
  if (proc) await encerrarServidor(proc);
  limparDir(DIR);
}
console.log(`\n${pass} ok, ${fail} falhas`);
process.exit(fail ? 1 : 0);
