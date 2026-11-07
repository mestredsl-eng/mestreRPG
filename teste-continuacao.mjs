// Testes de integração — Etapa 8: diário, anotações, continuidade, histórico, snapshots, timer
import Database from "better-sqlite3";
import { io as ioClient } from "socket.io-client";
import { hashToken } from "./servidor/dist/lib/password.js";

const BASE = "http://localhost:3001";
const API = BASE + "/api";
const db = new Database("banco/mestre-rpg.db");

const CID = "e8bbf8ea-c4d0-4bc1-9f1b-c4e6ec8558c0";   // Caçadores & Caçados
const CID2 = "1de51765-25aa-4713-b3f4-1ca866d10a27";  // Campanha Teste E4
const CHAR_T3 = "fc54075d-6eb0-4692-bff0-b225d404da41";
const U_ADMIN = "93e49f5a-5456-4066-9096-9ba26277bf51";
const U_JOG5 = "4c7999c1-b12e-4cd2-acb6-4188ab9bf657";
const U_JOG2 = "d3d69771-964b-43cd-9013-9208b50165b3";
const MEMBERSHIP_JOG2 = db.prepare("select id from memberships where campaign_id=? and user_id=?").get(CID, U_JOG2).id;

function sessaoHttp(username) {
  const u = db.prepare("select id from users where username=?").get(username);
  const token = "t8-" + crypto.randomUUID();
  db.prepare("insert into auth_sessions (id,user_id,token_hash,user_agent,ip,expires_at,created_at) values (?,?,?,?,?,?,?)")
    .run(crypto.randomUUID(), u.id, hashToken(token), "t", "127.0.0.1", Date.now() + 86400000, Date.now());
  return { token, cookie: `mestre_rpg_session=${encodeURIComponent(token)}` };
}
const ADMIN = sessaoHttp("admin");
const JOG5 = sessaoHttp("jogador_e5");
const JOG2 = sessaoHttp("jogador2");

async function req(metodo, path, { cookie = ADMIN.cookie, body, cid = CID } = {}) {
  const r = await fetch(`${API}/campaigns/${cid}${path}`, {
    method: metodo,
    headers: { "content-type": "application/json", cookie },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await r.json(); } catch { }
  return { status: r.status, json };
}
function conectar(cookie) {
  return ioClient(BASE, { path: "/socket.io", transports: ["polling", "websocket"], extraHeaders: { cookie }, reconnection: false });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function emitirCb(socket, evento, payload) {
  return new Promise((resolve) => socket.emit(evento, payload, resolve));
}
async function esperar(socket, evento, pred = () => true, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout ${evento}`)), timeout);
    const h = (d) => { if (pred(d)) { clearTimeout(t); socket.off(evento, h); resolve(d); } };
    socket.on(evento, h);
  });
}

let pass = 0, fail = 0;
const res = [];
const t = (n, c, extra = "") => { if (c) { pass++; res.push("ok " + n); } else { fail++; res.push("FALHOU " + n + " " + extra); } };
const ids = (lista) => new Set((lista ?? []).map((a) => a.id));

const N1 = "n1-" + crypto.randomUUID();
let sidHistoria, sidTimer;

try {
  // ============ 1-5: diário do jogador ============
  let r = await req("POST", "/anotacoes", { cookie: JOG5.cookie, body: { title: "Pista do caso E8", content: "Encontrei um bilhete", kind: "diario", characterId: CHAR_T3, visibility: "privada", category: "pista", important: true } });
  t("1 criar anotação própria", r.status === 201, JSON.stringify(r.json));
  const notaId = r.json?.id ?? N1;

  r = await req("PATCH", `/anotacoes/${notaId}`, { cookie: JOG5.cookie, body: { content: "Encontrei um bilhete — editado", important: false } });
  t("2 editar anotação própria", r.status === 200);
  let lista = (await req("GET", "/anotacoes?tipo=diario", { cookie: JOG5.cookie })).json?.anotacoes ?? [];
  t("2b edição persistiu", lista.find((a) => a.id === notaId)?.content?.includes("editado"));

  lista = (await req("GET", "/anotacoes?tipo=diario", { cookie: JOG2.cookie })).json?.anotacoes ?? [];
  t("3a privado não aparece p/ outro jogador", !ids(lista).has(notaId));
  r = await req("PATCH", `/anotacoes/${notaId}`, { cookie: JOG2.cookie, body: { title: "invadido" } });
  t("3b outro jogador não edita", r.status === 403);
  r = await req("DELETE", `/anotacoes/${notaId}`, { cookie: JOG2.cookie });
  t("3c outro jogador não exclui", r.status === 403);

  r = await req("PATCH", `/anotacoes/${notaId}`, { cookie: JOG5.cookie, body: { visibility: "mestre" } });
  lista = (await req("GET", "/anotacoes?tipo=diario", { cookie: ADMIN.cookie })).json?.anotacoes ?? [];
  t("4 compartilhar com mestre", r.status === 200 && ids(lista).has(notaId));

  r = await req("PATCH", `/anotacoes/${notaId}`, { cookie: JOG5.cookie, body: { visibility: "publica" } });
  lista = (await req("GET", "/anotacoes?tipo=diario", { cookie: JOG2.cookie })).json?.anotacoes ?? [];
  t("5 compartilhar com todos", r.status === 200 && ids(lista).has(notaId));

  // ============ 6-9: anotações do mestre ============
  r = await req("POST", "/anotacoes", { cookie: ADMIN.cookie, body: { title: "Segredo do vilão E8", content: "O vilão é o prefeito", kind: "mestre", visibility: "privada", category: "segredo" } });
  t("6 mestre cria nota privada", r.status === 201);
  const notaMestrePriv = r.json?.id;
  lista = (await req("GET", "/anotacoes?tipo=mestre", { cookie: JOG5.cookie })).json?.anotacoes ?? [];
  t("7 jogador não vê nota privada do mestre", !ids(lista).has(notaMestrePriv));

  r = await req("POST", "/anotacoes", { cookie: ADMIN.cookie, body: { title: "Dica só p/ T3", content: "Procure no cais", kind: "mestre", visibility: "selecionada", recipients: [U_JOG5], category: "pista" } });
  const notaMestreSel = r.json?.id;
  lista = (await req("GET", "/anotacoes?tipo=mestre", { cookie: JOG5.cookie })).json?.anotacoes ?? [];
  const lista2 = (await req("GET", "/anotacoes?tipo=mestre", { cookie: JOG2.cookie })).json?.anotacoes ?? [];
  t("8 mestre compartilha c/ jogador selecionado", ids(lista).has(notaMestreSel) && !ids(lista2).has(notaMestreSel));

  // jogador não cria nota de mestre
  r = await req("POST", "/anotacoes", { cookie: JOG5.cookie, body: { title: "x", kind: "mestre", visibility: "privada" } });
  t("8b jogador não cria nota de mestre", r.status === 403);

  // ============ 9: espectador ============
  db.prepare("update memberships set role='espectador' where id=?").run(MEMBERSHIP_JOG2);
  lista = (await req("GET", "/anotacoes?tipo=todas", { cookie: JOG2.cookie })).json?.anotacoes ?? [];
  const idsEsp = ids(lista);
  t("9a espectador vê apenas autorizadas", idsEsp.has(notaId) && !idsEsp.has(notaMestrePriv) && !idsEsp.has(notaMestreSel));
  r = await req("POST", "/anotacoes", { cookie: JOG2.cookie, body: { title: "esp", kind: "diario", visibility: "privada" } });
  t("9b espectador não cria anotação", r.status === 403);
  db.prepare("update memberships set role='jogador' where id=?").run(MEMBERSHIP_JOG2);

  // ============ 10-13: histórico de sessões ============
  r = await req("POST", "/sessoes", { body: { name: "Sessão E8 Teste" } });
  t("10a iniciar sessão", r.status === 201, JSON.stringify(r.json));
  sidHistoria = r.json?.sessao?.id;

  const sAdmin = conectar(ADMIN.cookie);
  const sJog5 = conectar(JOG5.cookie);
  const sJog2 = conectar(JOG2.cookie);
  await Promise.all([
    emitirCb(sAdmin, "mesa:entrar", { sessionId: sidHistoria }),
    emitirCb(sJog5, "mesa:entrar", { sessionId: sidHistoria }),
    emitirCb(sJog2, "mesa:entrar", { sessionId: sidHistoria }),
  ]);
  await emitirCb(sJog5, "mesa:mensagem", { sessionId: sidHistoria, content: "Ação pública E8", clientId: "c1" + Date.now() });
  await emitirCb(sJog5, "mesa:mensagem", { sessionId: sidHistoria, content: "PRIVADA_JOG5_ADMIN", visibilidade: "privada", destinatarioUserId: U_ADMIN, clientId: "c2" + Date.now() });
  await emitirCb(sAdmin, "mesa:mensagem", { sessionId: sidHistoria, content: "SECRETA_MESTRE_E8", visibilidade: "secreta", clientId: "c3" + Date.now() });
  await sleep(300);

  r = await req("PATCH", `/sessoes/${sidHistoria}`, { body: { status: "encerrada" } });
  t("10b encerrar sessão", r.status === 200);

  const histJog2 = (await req("GET", `/sessoes/${sidHistoria}/historico`, { cookie: JOG2.cookie })).json;
  const histAdm = (await req("GET", `/sessoes/${sidHistoria}/historico`, { cookie: ADMIN.cookie })).json;
  const histJog5 = (await req("GET", `/sessoes/${sidHistoria}/historico`, { cookie: JOG5.cookie })).json;
  const ev2 = JSON.stringify(histJog2?.eventos ?? []);
  const evA = JSON.stringify(histAdm?.eventos ?? []);
  const ev5 = JSON.stringify(histJog5?.eventos ?? []);
  t("10c histórico registra sessão encerrada", histJog2?.sessao?.status === "encerrada");
  t("11 participantes registrados", (histJog2?.participantes ?? []).some((p) => p.id === U_ADMIN) && (histJog2?.participantes ?? []).some((p) => p.id === U_JOG5));
  t("12 histórico não vaza msg privada p/ terceiro", !ev2.includes("PRIVADA_JOG5_ADMIN"));
  t("12b destinatário/mestre veem msg privada", evA.includes("PRIVADA_JOG5_ADMIN"));
  t("13a histórico não vaza msg secreta p/ jogador", !ev2.includes("SECRETA_MESTRE_E8") && !ev5.includes("SECRETA_MESTRE_E8"));
  t("13b mestre vê secreta no histórico", evA.includes("SECRETA_MESTRE_E8"));
  sAdmin.close(); sJog5.close(); sJog2.close();

  // ============ 14: resumo da campanha ============
  r = await req("PATCH", "", { body: { summary: "Resumo E8: os jogadores descobriram a pista do cais." } });
  t("14a mestre atualiza resumo", r.status === 200);
  r = await req("PATCH", "", { cookie: JOG5.cookie, body: { summary: "hack" } });
  t("14b jogador não atualiza resumo", r.status === 403);

  // ============ 15-19: snapshots ============
  const charsAntes = (await req("GET", "/characters", {})).json?.personagens?.length;
  const invAntes = db.prepare("select count(*) c from inventory_entries where character_id=?").get(CHAR_T3).c;

  r = await req("POST", "/snapshots", { body: { description: "Antes do teste E8" } });
  t("15 snapshot criado", r.status === 201, JSON.stringify(r.json));
  const snapId = r.json?.id;

  r = await req("POST", "/snapshots", { cookie: JOG5.cookie, body: {} });
  t("16 jogador não cria snapshot", r.status === 403);

  // cria dado novo que deve sumir após restore
  const tituloPos = `Nota pós-snapshot E8 ${Date.now()}`;
  await req("POST", "/anotacoes", { cookie: ADMIN.cookie, body: { title: tituloPos, kind: "diario", visibility: "privada" } });

  r = await req("POST", `/snapshots/${snapId}/restaurar`, { body: { confirmacao: "RESTAURAR" } });
  t("17 mestre restaura snapshot", r.status === 200, JSON.stringify(r.json));
  lista = (await req("GET", "/anotacoes?tipo=todas", { cookie: ADMIN.cookie })).json?.anotacoes ?? [];
  t("17b restore removeu dado posterior", !lista.some((a) => a.title === tituloPos));
  const audit = db.prepare("select action from audit_logs where campaign_id=? and action='snapshot.restaurado' order by created_at desc limit 1").get(CID);
  t("18 restauração auditada", !!audit, JSON.stringify(audit));
  const charsDepois = (await req("GET", "/characters", {})).json?.personagens?.length;
  const invDepois = db.prepare("select count(*) c from inventory_entries where character_id=?").get(CHAR_T3).c;
  t("19 personagens e patrimônio intactos", charsAntes === charsDepois && invAntes === invDepois, `${charsAntes}->${charsDepois} inv ${invAntes}->${invDepois}`);

  // ============ 20-22: temporizador ============
  r = await req("POST", "/sessoes", { body: { name: "Sessão Timer E8" } });
  sidTimer = r.json?.sessao?.id;
  const endsAtFuturo = Date.now() + 45000;
  db.prepare("update sessions set timer_state=? where id=?").run(JSON.stringify({ status: "rodando", endsAt: endsAtFuturo, remainingMs: 45000, totalMs: 60000 }), sidTimer);

  const sT1 = conectar(ADMIN.cookie);
  const sT2 = conectar(JOG5.cookie);
  await emitirCb(sT1, "mesa:entrar", { sessionId: sidTimer });
  await emitirCb(sT2, "mesa:entrar", { sessionId: sidTimer });
  let ticks1 = 0, ticks2 = 0, ultimoRest = null;
  const h1 = (d) => { if (d.sessionId === sidTimer && d.status === "rodando") { ticks1++; ultimoRest = d.remainingMs; } };
  const h2 = (d) => { if (d.sessionId === sidTimer && d.status === "rodando") ticks2++; };
  sT1.on("mesa:timer", h1); sT2.on("mesa:timer", h2);
  await sleep(2600);
  t("20 timer ativo é recuperado/sincronizado", ultimoRest !== null && ultimoRest < 45000 && ultimoRest > 40000, `rest=${ultimoRest}`);
  t("22 reconexão simultânea não duplica ticks", ticks1 >= 1 && ticks1 <= 4 && ticks2 >= 1 && ticks2 <= 4, `t1=${ticks1} t2=${ticks2}`);

  // timer expirado durante "indisponibilidade"
  db.prepare("update sessions set timer_state=? where id=?").run(JSON.stringify({ status: "rodando", endsAt: Date.now() - 1000, remainingMs: 0, totalMs: 60000 }), sidTimer);
  // o encerramento é confirmado pelo estado persistido; o evento socket é sincronização best-effort
  let parado = null;
  for (let i = 0; i < 20 && !parado; i++) {
    await sleep(250);
    const ts = JSON.parse(db.prepare("select timer_state from sessions where id=?").get(sidTimer)?.timer_state ?? "{}");
    if (ts.status === "parado") parado = ts;
  }
  t("21 timer expirado é encerrado", !!parado);
  sT1.close(); sT2.close();

  // ============ 23: salvamento automático ============
  r = await req("POST", "/anotacoes", { cookie: JOG5.cookie, body: { title: "Auto-save E8", kind: "diario", visibility: "privada" } });
  const nidAuto = r.json?.id;
  await req("PATCH", `/anotacoes/${nidAuto}`, { cookie: JOG5.cookie, body: { content: "v2 persistida" } });
  lista = (await req("GET", "/anotacoes?tipo=diario", { cookie: JOG5.cookie })).json?.anotacoes ?? [];
  t("23 alterações persistem automaticamente", lista.find((a) => a.id === nidAuto)?.content === "v2 persistida");

  // ============ 24: isolamento entre campanhas ============
  await req("POST", "/anotacoes", { cookie: ADMIN.cookie, body: { title: "Nota só E4", kind: "mestre", visibility: "privada" }, cid: CID2 });
  lista = (await req("GET", "/anotacoes?tipo=todas", { cookie: ADMIN.cookie })).json?.anotacoes ?? [];
  lista = (await req("GET", "/anotacoes?tipo=todas", { cookie: ADMIN.cookie, cid: CID2 })).json?.anotacoes ?? [];
  const emCnc = (await req("GET", "/anotacoes?tipo=todas", { cookie: ADMIN.cookie })).json?.anotacoes ?? [];
  t("24 campanhas isoladas", lista.some((a) => a.title === "Nota só E4") && !emCnc.some((a) => a.title === "Nota só E4"));
} catch (e) {
  fail++; res.push("EXCEÇÃO " + (e?.stack ?? e));
} finally {
  db.prepare("update memberships set role='jogador' where id=?").run(MEMBERSHIP_JOG2);
}

console.log(res.join("\n"));
console.log(`\n${pass} passaram, ${fail} falharam`);
process.exit(fail ? 1 : 0);
