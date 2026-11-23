// Testes — Issue #65 PR-A: regressão negativa de autorização.
// Prova, com efeitos colaterais zerados, que privilégios de um escopo
// não atravessam para outro e que revogação corta acesso HTTP e socket.
// Complementa (não duplica):
//   teste-escopo-cruzado.mjs → negação cruzada ADMIN/GM sem membership
//   teste-mesa-seguranca.mjs → papéis DENTRO da sessão de mesa
//   teste-guildas-admin.mjs  → IDOR entre guildas e multi-ADMIN
// Banco temporário + migrations reais + servidor spawnado (teardown seguro).
import { io as ioClient } from "socket.io-client";
import {
  dirTeste, prepararBanco, portaLivre, subirServidor, esperarSaudavel,
  encerrarServidor, limparDir, req, sessao, criarCenario, comDb, abrirDb,
} from "./teste-base.mjs";

const DIR = dirTeste("autorizacao-negativa");
const BANCO = `${DIR}/mestre-rpg-teste.db`;
await prepararBanco(BANCO);

let pass = 0, fail = 0;
const t = (n, c, extra = "") => { if (c) { pass++; console.log("  ok", n); } else { fail++; console.log("  FALHOU", n, extra); } };
const sec = (n) => console.log("\n== " + n + " ==");
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

const LOG_LIMITE = 200;
const logsServidor = { out: [], err: [] };
function consumirStream(stream, destino) {
  if (!stream) return;
  let resto = "";
  stream.on("data", (chunk) => {
    resto += String(chunk);
    const linhas = resto.split("\n");
    resto = linhas.pop() ?? "";
    for (const l of linhas) {
      if (l.trim()) { destino.push(l); if (destino.length > LOG_LIMITE) destino.shift(); }
    }
  });
}
function despejarLogs() {
  const cauda = (arr) => arr.slice(-15).join("\n");
  if (logsServidor.err.length) console.log("--- stderr do servidor (cauda) ---\n" + cauda(logsServidor.err));
  if (logsServidor.out.length) console.log("--- stdout do servidor (cauda) ---\n" + cauda(logsServidor.out));
}

const sockets = [];
function conectar(base, cookie) {
  const token = decodeURIComponent(cookie.split("=")[1]);
  const s = ioClient(base, {
    path: "/socket.io", transports: ["websocket", "polling"],
    extraHeaders: { cookie: `mestre_rpg_session=${encodeURIComponent(token)}` },
    reconnection: false,
  });
  sockets.push(s);
  return s;
}
const pronto = (s) => new Promise((res, rej) => { s.on("connect", res); s.on("connect_error", rej); });
const emitirCb = (s, ev, p) => new Promise((r) => {
  const to = setTimeout(() => r({ ok: false, erro: "timeout" }), 8000);
  s.emit(ev, p, (x) => { clearTimeout(to); r(x); });
});
const desconectou = (s, ms = 5000) => new Promise((res) => {
  const to = setTimeout(() => res(false), ms);
  s.on("disconnect", () => { clearTimeout(to); res(true); });
});

const porta = await portaLivre();
const base = `http://127.0.0.1:${porta}`;
const proc = subirServidor(porta, { banco: BANCO, arquivos: `${DIR}/arq`, backups: `${DIR}/bks` });
consumirStream(proc.stdout, logsServidor.out);
consumirStream(proc.stderr, logsServidor.err);

try {
  await esperarSaudavel(base, proc);
  sec("Cenário — duas campanhas, sessão em cada, dois jogadores");
  const C = await criarCenario(base, BANCO, { jogadores: { jogador1: "neg_j1", jogador2: "neg_j2" } });
  const { adminId, campId, cookieMestre, jogadores } = C;
  const j1 = jogadores.jogador1, j2 = jogadores.jogador2;

  // campanha B (mesmo mestre é titular das duas — o IDOR usa recursos
  // de B dentro das rotas de A, e a negação vem da membership de A)
  const campB = await req(base, "POST", "/campaigns", { cookie: cookieMestre, body: { name: "Campanha Neg B" } });
  const campBId = campB.json?.campanha?.id;
  t("campanha B criada", campB.status === 201 && !!campBId, JSON.stringify(campB.json).slice(0, 200));
  const membB = comDb(BANCO, (db) => db.prepare("select id from memberships where campaign_id=? and user_id=?").get(campBId, adminId).id);

  const sessA = await req(base, "POST", `/campaigns/${campId}/sessoes`, { cookie: cookieMestre, body: { nome: "Sessão Neg A" } });
  const sessB = await req(base, "POST", `/campaigns/${campBId}/sessoes`, { cookie: cookieMestre, body: { nome: "Sessão Neg B" } });
  const sidA = sessA.json?.sessao?.id, sidB = sessB.json?.sessao?.id;
  t("sessões criadas em A e B", !!sidA && !!sidB);

  const baseline = comDb(BANCO, (db) => ({
    testesB: db.prepare("select count(*) c from tests where session_id=?").get(sidB).c,
    msgsB: db.prepare("select count(*) c from chat_messages where session_id=?").get(sidB).c,
    papelJ2: db.prepare("select role||'|'||status r from memberships where id=?").get(j2.membershipId).r,
    adminJ1: db.prepare("select is_admin a from users where id=?").get(j1.id).a,
  }));

  sec("G7 — tentativa de escalada de papel por jogador");
  t("jogador PATCH próprio papel → 403",
    (await req(base, "PATCH", `/campaigns/${campId}/members/${j2.membershipId}`, { cookie: j2.cookie, body: { role: "mestre" } })).status === 403);
  t("jogador PATCH papel de outro membro → 403",
    (await req(base, "PATCH", `/campaigns/${campId}/members/${j1.membershipId}`, { cookie: j2.cookie, body: { role: "mestre" } })).status === 403);
  t("jogador PATCH /admin/users (forjar isAdmin) → 403",
    (await req(base, "PATCH", `/admin/users/${j1.id}`, { cookie: j2.cookie, body: { isAdmin: true } })).status === 403);
  t("jogador DELETE membership alheia → 403",
    (await req(base, "DELETE", `/campaigns/${campId}/members/${j1.membershipId}`, { cookie: j2.cookie })).status === 403);
  {
    const readback = comDb(BANCO, (db) => ({
      j2: db.prepare("select role||'|'||status r from memberships where id=?").get(j2.membershipId).r,
      j1: db.prepare("select role||'|'||status r from memberships where id=?").get(j1.membershipId).r,
      adminJ1: db.prepare("select is_admin a from users where id=?").get(j1.id).a,
    }));
    t("readback: papéis/status/is_admin inalterados",
      readback.j2 === baseline.papelJ2 && readback.j1 === "jogador|ativo" && readback.adminJ1 === 0,
      JSON.stringify(readback));
  }

  sec("G2 — sessionId de outra campanha nas rotas de sessão");
  for (const rota of ["", "/mensagens", "/testes", "/historico"]) {
    const r = await req(base, "GET", `/campaigns/${campId}/sessoes/${sidB}${rota}`, { cookie: j1.cookie });
    t(`GET A/sessoes/B${rota || " (detalhe)"} → 404`, r.status === 404, `status=${r.status}`);
  }
  {
    const depois = comDb(BANCO, (db) => ({
      testesB: db.prepare("select count(*) c from tests where session_id=?").get(sidB).c,
      msgsB: db.prepare("select count(*) c from chat_messages where session_id=?").get(sidB).c,
    }));
    t("zero efeitos colaterais na sessão B", depois.testesB === baseline.testesB && depois.msgsB === baseline.msgsB);
  }

  sec("G6 — recurso de outra campanha em rota de membership");
  t("PATCH members com membershipId da campanha B → 404",
    (await req(base, "PATCH", `/campaigns/${campId}/members/${membB}`, { cookie: cookieMestre, body: { role: "jogador" } })).status === 404);
  t("DELETE members com membershipId da campanha B → 404",
    (await req(base, "DELETE", `/campaigns/${campId}/members/${membB}`, { cookie: cookieMestre })).status === 404);
  t("jogador1 GET campanha B → 403 (sem membership)",
    (await req(base, "GET", `/campaigns/${campBId}`, { cookie: j1.cookie })).status === 403);
  {
    const papelB = comDb(BANCO, (db) => db.prepare("select role||'|'||status r from memberships where id=?").get(membB).r);
    t("readback: membership da campanha B inalterada", papelB === "mestre|ativo", papelB);
  }

  sec("G1 — revogação de membership com socket dentro da sessão");
  const sMestre = conectar(base, cookieMestre);
  const sJ1 = conectar(base, j1.cookie);
  await Promise.all([pronto(sMestre), pronto(sJ1)]);
  const rEntrar = await emitirCb(sJ1, "mesa:entrar", { sessionId: sidA });
  t("jogador1 entra na sessão antes da revogação", rEntrar?.ok === true, JSON.stringify(rEntrar));

  let j1Recebeu = 0, j1RecebeuDepois = 0;
  sJ1.on("mesa:mensagem", (d) => {
    const c = typeof d?.content === "string" ? d.content : "";
    if (/antes-revogacao/.test(c)) j1Recebeu++;
    if (/depois-revogacao/.test(c)) j1RecebeuDepois++;
  });
  await emitirCb(sMestre, "mesa:mensagem", { sessionId: sidA, content: "antes-revogacao", visibilidade: "publica" });
  await dormir(500);
  t("controle: jogador1 recebeu evento ANTES da revogação", j1Recebeu === 1, `n=${j1Recebeu}`);

  const rev = await req(base, "PATCH", `/campaigns/${campId}/members/${j1.membershipId}`, { cookie: cookieMestre, body: { status: "bloqueado" } });
  t("mestre bloqueia membership do jogador1", rev.status === 200, `status=${rev.status}`);

  const msgDepois = await emitirCb(sJ1, "mesa:mensagem", { sessionId: sidA, content: "tentativa-pos-revogacao" });
  t("ação socket do revogado → ok:false", msgDepois?.ok === false, JSON.stringify(msgDepois));
  await emitirCb(sMestre, "mesa:mensagem", { sessionId: sidA, content: "depois-revogacao", visibilidade: "publica" });
  await dormir(700);
  t("revogado NÃO recebe eventos da sessão depois", j1RecebeuDepois === 0, `n=${j1RecebeuDepois}`);
  t("HTTP do revogado → 403", (await req(base, "GET", `/campaigns/${campId}`, { cookie: j1.cookie })).status === 403);
  {
    const readback = comDb(BANCO, (db) => db.prepare("select status s from memberships where id=?").get(j1.membershipId).s);
    t("readback: membership ficou bloqueado", readback === "bloqueado", readback);
  }

  sec("G5 — bloqueio de conta com socket vivo");
  const sJ2 = conectar(base, j2.cookie);
  await pronto(sJ2);
  const rEntrar2 = await emitirCb(sJ2, "mesa:entrar", { sessionId: sidA });
  t("jogador2 entra na sessão (controle)", rEntrar2?.ok === true, JSON.stringify(rEntrar2));
  const caiu = desconectou(sJ2);
  const bloq = await req(base, "PATCH", `/admin/users/${j2.id}`, { cookie: cookieMestre, body: { status: "bloqueado" } });
  t("admin bloqueia conta do jogador2", bloq.status === 200, `status=${bloq.status}`);
  t("socket da conta bloqueada é desconectado", await caiu);
  t("HTTP do bloqueado → 401", (await req(base, "GET", "/auth/me", { cookie: j2.cookie })).status === 401);
} catch (e) {
  fail++;
  console.log("FALHOU exceção não tratada:", e?.stack ?? e);
} finally {
  let teardownFalhou = false;
  try {
    for (const s of sockets) s.disconnect();
  } catch (e) {
    teardownFalhou = true;
    console.error("[teardown] sockets:", e?.message ?? e);
  }
  try {
    await encerrarServidor(proc);
  } catch (e) {
    teardownFalhou = true;
    console.error("[teardown] servidor:", e?.message ?? e);
  }
  try {
    if (!limparDir(DIR)) teardownFalhou = true;
  } catch (e) {
    teardownFalhou = true;
    console.error("[teardown] limpeza:", e?.message ?? e);
  }
  if (fail > 0) despejarLogs();
  if (teardownFalhou) fail++;
}

console.log(`\n${pass} ok, ${fail} falhas`);
process.exit(fail ? 1 : 0);
