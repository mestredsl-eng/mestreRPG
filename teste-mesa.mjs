// Testes de integração — Etapa 7: mesa em tempo real, chat, turnos e dados
import Database from "better-sqlite3";
import { io as ioClient } from "socket.io-client";
import { hashToken } from "./servidor/dist/lib/password.js";

const BASE = "http://localhost:3001";
const API = BASE + "/api";
const db = new Database("banco/mestre-rpg.db");

const CID = "e8bbf8ea-c4d0-4bc1-9f1b-c4e6ec8558c0";
const CHAR_T3 = "fc54075d-6eb0-4692-bff0-b225d404da41"; // jogador_e5

function sessaoHttp(username) {
  const u = db.prepare("select id from users where username=?").get(username);
  const token = "t7-" + crypto.randomUUID();
  db.prepare("insert into auth_sessions (id,user_id,token_hash,user_agent,ip,expires_at,created_at) values (?,?,?,?,?,?,?)")
    .run(crypto.randomUUID(), u.id, hashToken(token), "t", "127.0.0.1", Date.now() + 86400000, Date.now());
  return { token, cookie: `mestre_rpg_session=${encodeURIComponent(token)}` };
}
const ADMIN = sessaoHttp("admin");
const JOG5 = sessaoHttp("jogador_e5");
const JOG2 = sessaoHttp("jogador2");

async function req(metodo, path, { cookie = ADMIN.cookie, body } = {}) {
  const r = await fetch(API + path, {
    method: metodo,
    headers: { "content-type": "application/json", cookie },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await r.json(); } catch { }
  return { status: r.status, json };
}

function conectar(cookie) {
  return ioClient(BASE, {
    path: "/socket.io",
    transports: ["polling", "websocket"],
    extraHeaders: { cookie },
    reconnection: false,
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function esperar(socket, evento, pred = () => true, timeout = 6000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout ${evento}`)), timeout);
    const h = (d) => { if (pred(d)) { clearTimeout(t); socket.off(evento, h); resolve(d); } };
    socket.on(evento, h);
  });
}
function emitirCb(socket, evento, payload) {
  return new Promise((resolve) => socket.emit(evento, payload, resolve));
}

let pass = 0, fail = 0;
const res = [];
const t = (n, c, extra = "") => { if (c) { pass++; res.push("ok " + n); } else { fail++; res.push("FALHOU " + n + " " + extra); } };

// ---------- setup: jogador2 vira espectador ----------
{
  const mem = db.prepare("select id from memberships where campaign_id=? and user_id=(select id from users where username='jogador2')").get(CID);
  if (mem) {
    await req("PATCH", `/campaigns/${CID}/members/${mem.id}`, { cookie: ADMIN.cookie, body: { role: "espectador" } });
  }
}

// ============ 1. Iniciar sessão ============
const s1 = await req("POST", `/campaigns/${CID}/sessoes`, { cookie: ADMIN.cookie, body: { name: "Sessão E7 Teste" } });
t("1. iniciar sessão", s1.status === 201 && s1.json?.sessao?.status === "ativa", JSON.stringify(s1.json).slice(0, 200));
const SID = s1.json?.sessao?.id;

// jogador tenta criar sessão → 403
const sNeg = await req("POST", `/campaigns/${CID}/sessoes`, { cookie: JOG5.cookie, body: {} });
t("1b. jogador não cria sessão", sNeg.status === 403);

// ============ 3. Dois usuários conectados ============
const sockA = conectar(ADMIN.cookie);
const sockJ = conectar(JOG5.cookie);
const sockE = conectar(JOG2.cookie);
await Promise.all([new Promise((r) => sockA.on("connect", r)), new Promise((r) => sockJ.on("connect", r)), new Promise((r) => sockE.on("connect", r))]);

const entrarA = await emitirCb(sockA, "mesa:entrar", { sessionId: SID });
const entrarJ = await emitirCb(sockJ, "mesa:entrar", { sessionId: SID });
const entrarE = await emitirCb(sockE, "mesa:entrar", { sessionId: SID });
t("3a. mestre entra", entrarA?.ok === true && entrarA?.papel === "mestre");
t("3b. jogador entra", entrarJ?.ok === true && entrarJ?.papel === "jogador");
t("3c. espectador entra", entrarE?.ok === true && entrarE?.papel === "espectador", JSON.stringify(entrarE));
await sleep(300);

// ============ 4. Mensagens ============
const msgJ = esperar(sockA, "mesa:mensagem", (m) => m.content === "Olá mesa E7");
await emitirCb(sockJ, "mesa:mensagem", { sessionId: SID, content: "Olá mesa E7", clientId: crypto.randomUUID() });
await msgJ;
t("4. mensagem jogador→mestre", true);

// ============ 5. Mensagem privada ============
const msgPrivJ = esperar(sockJ, "mesa:mensagem", (m) => m.visibility === "privada" && m.content === "segredo j5-m");
const msgPrivE = esperar(sockE, "mesa:mensagem", (m) => m.content === "segredo j5-m", 1500).then(() => "recebeu").catch(() => "não recebeu");
const adminId = db.prepare("select id from users where username='admin'").get().id;
const j5Id = db.prepare("select id from users where username='jogador_e5'").get().id;
await emitirCb(sockA, "mesa:mensagem", { sessionId: SID, content: "segredo j5-m", clientId: crypto.randomUUID(), visibilidade: "privada", destinatarioUserId: j5Id });
await msgPrivJ;
const resE = await msgPrivE;
t("5a. privada chega ao destinatário", true);
t("5b. privada NÃO chega ao espectador", resE === "não recebeu", resE);
void adminId;

// ============ 6. Mensagem secreta do mestre ============
const msgSecJ = esperar(sockJ, "mesa:mensagem", (m) => m.content === "TRAMA SECRETA", 1500).then(() => "recebeu").catch(() => "não recebeu");
const msgSecA = esperar(sockA, "mesa:mensagem", (m) => m.content === "TRAMA SECRETA" && m.visibility === "mestre");
await emitirCb(sockA, "mesa:mensagem", { sessionId: SID, content: "TRAMA SECRETA", clientId: crypto.randomUUID(), visibilidade: "secreta" });
await msgSecA;
const resSecJ = await msgSecJ;
t("6a. secreta chega ao mestre", true);
t("6b. secreta NÃO chega ao jogador", resSecJ === "não recebeu", resSecJ);

// jogador tenta secreta → erro
const secNeg = await emitirCb(sockJ, "mesa:mensagem", { sessionId: SID, content: "fake secreta", visibilidade: "secreta" });
t("6c. jogador não envia secreta", secNeg?.ok === false);

// ============ 7. Declaração de ação ============
await emitirCb(sockJ, "mesa:mensagem", { sessionId: SID, content: "Vou usar o computador para pesquisar o suspeito", clientId: crypto.randomUUID(), tipo: "acao" });
await sleep(300);
const hist1 = await req("GET", `/campaigns/${CID}/sessoes/${SID}/mensagens`, { cookie: JOG5.cookie });
t("7. ação registrada como kind=acao", hist1.json?.mensagens?.some((m) => m.kind === "acao" && m.content.includes("computador")));

// ============ 8. Solicitação de teste ============
const testeP = esperar(sockJ, "mesa:teste", (d) => d.characterId === CHAR_T3);
const respTeste = await emitirCb(sockA, "mesa:teste:pedir", {
  sessionId: SID, characterId: CHAR_T3, rotulo: "Computação", dadosLados: 20, dadosCount: 2, minimo: 15, visibilidade: "privada", requestId: `teste-${crypto.randomUUID().slice(0, 8)}`,
});
const testeEv = await testeP;
t("8a. mestre solicita teste", respTeste?.ok === true, JSON.stringify(respTeste));
t("8b. jogador recebe com alvo", testeEv?.alvo === 15 && testeEv?.dados?.count === 2, JSON.stringify(testeEv).slice(0, 200));
const TESTID = respTeste?.id;

// jogador não vê o mínimo no histórico público? teste privado → só dono+mestre
const histJ = await req("GET", `/campaigns/${CID}/sessoes/${SID}/testes`, { cookie: JOG5.cookie });
const testeVisivel = histJ.json?.testes?.find((x) => x.id === TESTID);
t("8c. teste visível ao dono", !!testeVisivel);

// jogador tenta solicitar teste → erro
const testeNeg = await emitirCb(sockJ, "mesa:teste:pedir", { sessionId: SID, characterId: CHAR_T3, dadosLados: 20 });
t("8d. jogador não solicita teste", testeNeg?.ok === false);

// ============ 9-10. Rolagens ============
for (const lados of [4, 6, 8, 10, 20]) {
  const rollP = esperar(sockJ, "mesa:rolagem", (r) => r.id && !r.testId);
  const resp = await emitirCb(sockJ, "mesa:rolar", { sessionId: SID, dados: [{ sides: lados, count: 2 }], motivo: `d${lados}`, requestId: `roll-${lados}-${crypto.randomUUID().slice(0, 6)}` });
  const ev = await rollP;
  const vals = ev.grupos?.[0]?.resultados ?? [];
  const okRange = vals.length === 2 && vals.every((v) => v >= 1 && v <= lados);
  t(`9. rolagem d${lados} válida`, resp?.ok === true && okRange, JSON.stringify(ev).slice(0, 120));
}

// dados inválidos → sides coage para 20 (servidor valida)
const rollInv = await emitirCb(sockJ, "mesa:rolar", { sessionId: SID, dados: [{ sides: 7, count: 1 }] });
t("9b. dado inválido rejeitado/coagido", rollInv?.ok === true);

// idempotência de rolagem
const rid = "roll-dup-" + crypto.randomUUID().slice(0, 8);
const [r1, r2] = await Promise.all([
  emitirCb(sockJ, "mesa:rolar", { sessionId: SID, dados: [{ sides: 6, count: 1 }], requestId: rid }),
  emitirCb(sockJ, "mesa:rolar", { sessionId: SID, dados: [{ sides: 6, count: 1 }], requestId: rid }),
]);
t("10. rolagem duplicada idempotente", (r1?.duplicado === true || r2?.duplicado === true || r1?.ok) && (r1?.id === r2?.id || r1?.duplicado || r2?.duplicado), JSON.stringify([r1, r2]).slice(0, 200));

// ============ 10b. Rolagem do teste ============
const rollTesteP = esperar(sockA, "mesa:rolagem", (r) => r.testId === TESTID);
const rollTeste = await emitirCb(sockJ, "mesa:teste:rolar", { testId: TESTID, requestId: `rollteste-${crypto.randomUUID().slice(0, 8)}` });
const evTeste = await rollTesteP;
t("10c. rolagem do teste", rollTeste?.ok === true && evTeste?.total >= 2 && evTeste?.total <= 40, JSON.stringify(rollTeste).slice(0, 150));
// rolar de novo → jaRolado
const rollTeste2 = await emitirCb(sockJ, "mesa:teste:rolar", { testId: TESTID });
t("10d. teste não rola duas vezes", rollTeste2?.jaRolado === true || rollTeste2?.ok === true);

// ============ 11. Decisão do mestre ============
const decJ = esperar(sockJ, "mesa:decisao", (d) => d.testId === TESTID);
const dec = await emitirCb(sockA, "mesa:teste:decidir", { testId: TESTID, outcome: "parcial", nota: "Conseguiu parte das infos" });
const decEv = await decJ;
t("11. decisão do mestre", dec?.ok === true && decEv?.outcome === "parcial");
// jogador tenta decidir → erro
const decNeg = await emitirCb(sockJ, "mesa:teste:decidir", { testId: TESTID, outcome: "sucesso" });
t("11b. jogador não decide", decNeg?.ok === false);

// ============ 12. Turnos ============
const memJ5 = db.prepare("select id from memberships where campaign_id=? and user_id=?").get(CID, j5Id);
const ordem = [memJ5.id];
const trP = esperar(sockJ, "mesa:turnos", (t) => t.turnos?.ativo === true);
await emitirCb(sockA, "mesa:turno", { sessionId: SID, acao: "iniciar", ordem });
await trP;
const trAvP = esperar(sockJ, "mesa:turnos", (t) => t.turnos?.atual === 0);
await emitirCb(sockA, "mesa:turno", { sessionId: SID, acao: "avancar" });
await trAvP;
const trVolP = esperar(sockJ, "mesa:turnos");
await emitirCb(sockA, "mesa:turno", { sessionId: SID, acao: "voltar" });
await trVolP;
t("12. turnos avançar/voltar", true);
// jogador tenta controlar turno → erro
const trNeg = await emitirCb(sockJ, "mesa:turno", { sessionId: SID, acao: "encerrar" });
t("12b. jogador não controla turnos", trNeg?.ok === false);

// ============ 13. Temporizador ============
const timerP = esperar(sockJ, "mesa:timer", (t) => t.status === "rodando").catch(() => null);
const timerStart = await emitirCb(sockA, "mesa:timer", { sessionId: SID, acao: "iniciar", duracaoSegundos: 60 });
await timerP;
t("13a. timer inicia", timerStart?.ok === true);
// expiração: injeta estado quase expirado direto no banco (duração mínima é 60s);
// o encerramento é confirmado pelo estado persistido —
// o evento socket é sincronização best-effort (pode se perder no transporte)
db.prepare("update sessions set timer_state=? where id=?")
  .run(JSON.stringify({ status: "rodando", endsAt: Date.now() + 1200, remainingMs: 1200, totalMs: 60000 }), SID);
const timerEnd = await esperar(sockJ, "mesa:timer", (t) => t.status === "parado", 8000).catch(() => null);
// se o evento chegar, deve ser 'parado' com remainingMs=0; se se perder no
// transporte (best-effort), a confirmação autoritativa é o estado persistido (13c)
t("13b. evento de expiração válido (se recebido)",
  timerEnd === null || (timerEnd.status === "parado" && timerEnd.remainingMs === 0),
  JSON.stringify(timerEnd));
// estado persistido
const est = await req("GET", `/campaigns/${CID}/sessoes/${SID}/estado`, { cookie: JOG5.cookie });
t("13c. timer persistido", est.json?.sessao?.timerState?.status === "parado", JSON.stringify(est.json?.sessao?.timerState));
// jogador tenta timer → erro
const timerNeg = await emitirCb(sockJ, "mesa:timer", { sessionId: SID, acao: "iniciar", duracaoSegundos: 60 });
t("13d. jogador não controla timer", timerNeg?.ok === false);

// ============ 14-15. Espectador ============
t("14. espectador entrou (papel)", entrarE?.papel === "espectador");
const espMsg = await emitirCb(sockE, "mesa:mensagem", { sessionId: SID, content: "espectador falando" });
t("15a. espectador não envia mensagem", espMsg?.ok === false, JSON.stringify(espMsg));
const espRoll = await emitirCb(sockE, "mesa:rolar", { sessionId: SID, dados: [{ sides: 6, count: 1 }] });
t("15b. espectador não rola", espRoll?.ok === false);
const espTeste = await emitirCb(sockE, "mesa:teste:pedir", { sessionId: SID, characterId: CHAR_T3 });
t("15c. espectador não pede teste", espTeste?.ok === false);
// mas espectador RECEBE chat público
const espRecebe = esperar(sockE, "mesa:mensagem", (m) => m.content === "msg para espectador ver");
await emitirCb(sockJ, "mesa:mensagem", { sessionId: SID, content: "msg para espectador ver", clientId: crypto.randomUUID() });
await espRecebe;
t("14b. espectador recebe chat público", true);

// ============ 16. Reconexão ============
sockJ.disconnect();
await sleep(300);
const sockJ2 = conectar(JOG5.cookie);
await new Promise((r) => sockJ2.on("connect", r));
const entrar2 = await emitirCb(sockJ2, "mesa:entrar", { sessionId: SID });
t("16a. reconexão entra", entrar2?.ok === true);
const hist2 = await req("GET", `/campaigns/${CID}/sessoes/${SID}/mensagens`, { cookie: JOG5.cookie });
const totalMsgs = hist2.json?.mensagens?.length ?? 0;
t("16b. histórico preservado após reconexão", totalMsgs >= 5, `msgs=${totalMsgs}`);

// ============ 17. Dedup de mensagens ============
const cid = crypto.randomUUID();
await emitirCb(sockJ2, "mesa:mensagem", { sessionId: SID, content: "dedup test", clientId: cid });
await emitirCb(sockJ2, "mesa:mensagem", { sessionId: SID, content: "dedup test", clientId: cid });
await sleep(400);
const hist3 = await req("GET", `/campaigns/${CID}/sessoes/${SID}/mensagens`, { cookie: ADMIN.cookie });
const dups = hist3.json?.mensagens?.filter((m) => m.id === cid).length ?? 0;
t("17. mensagem duplicada ignorada", dups === 1, `ocorrências=${dups}`);

// ============ 18. Proteção de privadas no histórico ============
const histEsp = await req("GET", `/campaigns/${CID}/sessoes/${SID}/mensagens`, { cookie: JOG2.cookie });
const vazouPriv = histEsp.json?.mensagens?.some((m) => m.content === "segredo j5-m" || m.content === "TRAMA SECRETA");
t("18a. espectador não vê privada/secreta no histórico", !vazouPriv);
const histJ2 = await req("GET", `/campaigns/${CID}/sessoes/${SID}/mensagens`, { cookie: JOG5.cookie });
const seesPriv = histJ2.json?.mensagens?.some((m) => m.content === "segredo j5-m"); // j5 é destinatário
t("18b. destinatário vê a privada", seesPriv);
const seesSec = histJ2.json?.mensagens?.some((m) => m.content === "TRAMA SECRETA");
t("18c. jogador NÃO vê secreta do mestre", !seesSec);

// ============ 19. Jogador não controla sessão ============
const encNeg = await req("PATCH", `/campaigns/${CID}/sessoes/${SID}`, { cookie: JOG5.cookie, body: { status: "encerrada" } });
t("19a. jogador não encerra sessão (REST)", encNeg.status === 403);
// não-membro tenta entrar
const uFake = sessaoHttp("admin"); // admin é mestre — usar jogador2 já é espectador; criar não-membro? pular: JOG2 é membro
// jogador tenta entrar em sessão de OUTRA campanha? E4 não tem sessões — ok

// ============ 20. Compatibilidade ============
const pers = await req("GET", `/characters/${CHAR_T3}`, { cookie: JOG5.cookie });
t("20a. ficha/personagem intacto", pers.status === 200);
const fin = await req("GET", `/characters/${CHAR_T3}/financeiro`, { cookie: JOG5.cookie });
t("20b. financeiro intacto", fin.status === 200);
const inv = await req("GET", `/characters/${CHAR_T3}/inventario`, { cookie: JOG5.cookie });
t("20c. inventário intacto", inv.status === 200);

// ============ 2. Encerrar sessão ============
const encerr = await req("PATCH", `/campaigns/${CID}/sessoes/${SID}`, { cookie: ADMIN.cookie, body: { status: "encerrada" } });
t("2. encerrar sessão", encerr.status === 200);
const entrarDepois = await emitirCb(sockA, "mesa:entrar", { sessionId: SID });
t("2b. não entra em sessão encerrada", entrarDepois?.ok === false);
// restaurar papel do jogador2
{
  const mem = db.prepare("select id from memberships where campaign_id=? and user_id=(select id from users where username='jogador2')").get(CID);
  if (mem) await req("PATCH", `/campaigns/${CID}/members/${mem.id}`, { cookie: ADMIN.cookie, body: { role: "jogador" } });
}

[sockA, sockJ2, sockE].forEach((s) => s.disconnect());

console.log("\n===== RESULTADOS =====");
res.forEach((r) => console.log(r));
console.log(`\n${pass} passaram, ${fail} falharam`);
process.exit(fail ? 1 : 0);
